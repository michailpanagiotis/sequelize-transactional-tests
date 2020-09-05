const Mocha = require('mocha');
const Sequelize = require('sequelize');
const cls = require('cls-hooked');
const { Transaction } = require('sequelize');

const noClsError = new Error(`
  Sequelize does not have a CLS, set it by running Sequelize.useCLS(namespace)
  (https://sequelize.org/master/manual/transactions.html#automatically-pass-transactions-to-all-queries)
`);

const getNamespace = () => {
  if (!Sequelize._cls) {
    throw noClsError;
  }
  const { name } = Sequelize._cls;
  return cls.getNamespace(name);
};

const getCurrentTransaction = () => getNamespace().get('transaction');
const setCurrentTransaction = (tr) => getNamespace().set('transaction', tr);

const getLastSavepoint = () => {
  const tr = getCurrentTransaction();
  if (!tr) {
    return null;
  }
  let lastSp = tr;
  if (tr.savepoints.length > 0) {
    for (let l = tr.savepoints.length - 1; l >= 0; l -= 1) {
      if (!tr.savepoints[l].finished) {
        lastSp = tr.savepoints[l];
        break;
      }
    }
  }
  return lastSp;
};

const patchSavepoints = (transaction, { commitOnError = false } = {}) => {
  Object.assign(transaction.savepoints, {
    push: function push(savepoint) {
      const origCommit = savepoint.commit.bind(savepoint);
      Object.assign(savepoint, {
        commit: () => {
          if (!commitOnError) {
            process.emitWarning('transaction commits are disabled in order for tests to use the transactional pattern', 'TransactionalWarning');
          }
          return origCommit();
        },
      });
      Array.prototype.push.call(this, savepoint);
    },
  });
};

const walkSuite = (suite, fn) => {
  fn(suite);
  suite.suites.forEach((s) => walkSuite(s, fn));
};

const suiteFailed = (suite) => {
  let failed = false;
  walkSuite(suite, (s) => {
    if (s.tests && s.tests.length > 0) {
      failed = s.tests.some((t) => t.state === 'failed');
    }
  });

  return failed;
};

const bindHooksAndTests = (suite) => {
  ['tests', '_beforeAll', '_beforeEach', '_afterAll', '_afterEach'].forEach((set) => {
    suite[set].forEach((test) => {
      Object.assign(test, { fn: getNamespace().bind(test.fn) });
    });
  });
};

class SequelizeTransactionHandler {
  constructor({
    sequelize, commitOnError = false,
    onTransaction = () => {}, onCommit = () => {}, onRollback = () => {},
  } = {}) {
    if (!sequelize) {
      throw new Error('undefined parameter \'sequelize\'');
    }
    this.sequelize = sequelize;
    this.commitOnError = commitOnError;
    this.onTransaction = onTransaction;
    this.onCommit = onCommit;
    this.onRollback = onRollback;
  }

  transaction(descriptor) {
    const sequelize = typeof this.sequelize === 'function' ? this.sequelize() : this.sequelize;
    const current = getCurrentTransaction();
    return sequelize.transaction({
      transaction: current,
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_UNCOMMITTED,
    }).then((t) => {
      if (!current) {
        patchSavepoints(t);
        setCurrentTransaction(t);
      }
      return t;
    }).then((t) => this.onTransaction(t, descriptor));
  }

  stop(failed = false, descriptor) {
    const { commitOnError } = this;
    return failed && commitOnError ? this.commit(descriptor) : this.rollback(descriptor);
  }

  commit(descriptor) {
    const ended = getLastSavepoint();
    if (!ended || ended.finished) {
      return Promise.resolve(ended);
    }
    return ended.commit().then(() => {
      if (!ended.parent) {
        setCurrentTransaction(null);
      }
      return ended;
    }).then((t) => this.onCommit(t, descriptor));
  }

  rollback(descriptor) {
    const ended = getLastSavepoint();
    if (!ended) {
      throw new Error('missing ended');
    }
    if (!ended || ended.finished) {
      return Promise.resolve(ended);
    }
    return ended.rollback().then(() => {
      if (!ended.parent) {
        setCurrentTransaction(null);
      }
      return ended;
    }).then((t) => this.onRollback(t, descriptor));
  }
}

class MochaSuiteHandler {
  constructor(transactionHandler, { wrapChildren = false } = {}) {
    this.tHandler = transactionHandler;
    this.wrapChildren = wrapChildren;
  }

  wrapTests(suite) {
    const { tHandler } = this;
    // add mocha hooks to tests
    suite.beforeEach(function beforeEach() {
      const inPath = this.currentTest.fullTitle();
      return tHandler.transaction(inPath);
    });
    // make sure the transaction starts before any other beforeEach hook
    suite._beforeEach.unshift(suite._beforeEach.pop());
    suite.afterEach(function afterEach() {
      const inPath = this.currentTest.fullTitle();
      return tHandler.stop(suiteFailed(suite), inPath);
    });
  }

  wrapSuite(suite) {
    const { tHandler, wrapChildren } = this;
    if (!suite.root) {
      // add mocha hooks to inner suites
      const path = suite.fullTitle();
      const inPath = `${suite.fullTitle()} beforeAll`;
      suite.beforeAll(() => tHandler.transaction(path));
      // make sure the transaction starts before any other beforeAll hook
      suite._beforeAll.unshift(suite._beforeAll.pop());

      if (wrapChildren) {
        suite.beforeAll(() => tHandler.transaction(inPath));

        suite.afterAll(() => tHandler.stop(suiteFailed(suite), inPath));
        // make sure the transaction ends before any other afterAll hook
        suite._afterAll.unshift(suite._afterAll.pop());
      }

      suite.afterAll(() => tHandler.stop(suiteFailed(suite), path));
    }
    bindHooksAndTests(suite);
  }
}

class Transactional {
  constructor({
    sequelize, commitOnError = false, wrapChildren = false, wrapRoot = false,
    onTransaction = () => {}, onCommit = () => {}, onRollback = () => {},
  } = {}) {
    if (!sequelize) {
      throw new Error('undefined parameter \'sequelize\'');
    }
    const transactionHandler = new SequelizeTransactionHandler({
      sequelize, commitOnError, onTransaction, onCommit, onRollback,
    });
    this.suiteHandler = new MochaSuiteHandler(transactionHandler, { wrapChildren });
    if (wrapRoot) {
      try {
        const runnerFn = Mocha.Runner.prototype.runSuite;
        const tHandler = this;
        Object.assign(Mocha.Runner.prototype, {
          runSuite: function run(suite, fn) {
            if (suite.root) {
              // add mocha hooks for starting/rolling back transactions on the
              // boundaries of each test/suite
              tHandler.bind(suite);
            }
            return runnerFn.bind(this)(suite, fn);
          },
        });
      } catch (e) {
        console.error(e);
      }
    }
  }

  bind(suite) {
    const transactional = this;
    const { suiteHandler } = this;
    if (typeof suite === 'function') {
      return function wT(...args) {
        const res = suite.bind(this)(...args);
        transactional.bind(this);
        return res;
      };
    }

    return getNamespace().run(() => {
      suiteHandler.wrapTests(suite);
      walkSuite(suite, suiteHandler.wrapSuite.bind(suiteHandler));
    });
  }
}

module.exports = Transactional;
