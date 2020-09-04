const Mocha = require('mocha');
const Sequelize = require('sequelize');
const EventEmitter = require('events');
const cls = require('cls-hooked');
const { Transaction } = require('sequelize');

let tHandler;

const noClsError = new Error(`
  Sequelize does not have a CLS, set it by running Sequelize.useCLS(namespace)
  (https://sequelize.org/master/manual/transactions.html#automatically-pass-transactions-to-all-queries)
`);

class TransactionHandler extends EventEmitter {
  constructor({
    sequelize, commitOnError = false, wrapRoot = false, wrapChildren = false,
    onTransaction = () => {}, onCommit = () => {}, onRollback = () => {},
  } = {}) {
    if (!sequelize) {
      throw new Error('undefined parameter \'sequelize\'');
    }
    super();
    this.sequelize = sequelize;
    this.commitOnError = commitOnError;
    this.wrapChildren = wrapChildren;
    this.onTransaction = onTransaction;
    this.onCommit = onCommit;
    this.onRollback = onRollback;
  }

  getNamespaceName() {
    const ns = this.getNamespace();
    if (ns) {
      return ns.name;
    }
    return null;
  }

  getNamespace() {
    if (!Sequelize._cls) {
      throw noClsError;
    }
    const { name } = Sequelize._cls;
    const namespace = cls.getNamespace(name);
    return namespace;
  }

  getSequelize() {
    return typeof this.sequelize === 'function' ? this.sequelize() : this.sequelize;
  }

  getCurrentTransaction() {
    return this.getNamespace().get('transaction');
  }

  transaction(mochaPath) {
    const sequelize = this.getSequelize();
    const current = this.getCurrentTransaction();
    return sequelize.transaction({
      transaction: current,
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_UNCOMMITTED,
    }).then((t) => {
      if (!current) {
        this._patchSavepoints(t);
        this.getNamespace().set('transaction', t);
      }
      this.emit('transaction', t, mochaPath);
      return t;
    }).then((t) => this.onTransaction(t, mochaPath));
  }

  stop(failed = false, mochaPath) {
    const { commitOnError } = this;
    return failed && commitOnError ? this._commit(mochaPath) : this._rollback(mochaPath);
  }

  _patchSequelize() {
    const sequelize = this.getSequelize();
    const transactionFn = sequelize.transaction;
    Object.assign(sequelize, {
      transaction: function transaction(...args) {
        process.emitWarning('user transactions ', 'TransactionalWarning');
        return transactionFn.bind(this)(...args);
      },
    });
  }

  _commit(mochaPath) {
    const ended = this._getLastSavepoint();
    if (!ended || ended.finished) {
      return Promise.resolve(ended);
    }
    return ended.commit().then(() => {
      if (!ended.parent) {
        this.getNamespace().set('transaction', null);
      }
      this.emit('commit', ended, mochaPath);
      return ended;
    }).then((t) => this.onCommit(t, mochaPath));
  }

  _rollback(mochaPath) {
    const ended = this._getLastSavepoint();
    if (!ended) {
      throw new Error('missing ended');
    }
    if (!ended || ended.finished) {
      return Promise.resolve(ended);
    }
    return ended.rollback().then(() => {
      if (!ended.parent) {
        this.getNamespace().set('transaction', null);
      }
      this.emit('rollback', ended, mochaPath);
      return ended;
    }).then((t) => this.onRollback(t, mochaPath));
  }

  _patchSavepoints(transaction) {
    const { commitOnError } = this;
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
  }

  _getLastSavepoint() {
    const tr = this.getCurrentTransaction();
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
  }
}

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

const makeTransactional = (rootSuite) => {
  if (typeof rootSuite === 'function') {
    return function wT(...args) {
      const res = rootSuite.bind(this)(...args);
      makeTransactional(this);
      return res;
    };
  }
  walkSuite(rootSuite, (suite) => {
    if (suite === rootSuite) {
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
    if (!suite.root) {
      // add mocha hooks to inner suites
      const path = suite.fullTitle();
      const inPath = `${suite.fullTitle()} beforeAll`;
      suite.beforeAll(() => tHandler.transaction(path));
      // make sure the transaction starts before any other beforeAll hook
      suite._beforeAll.unshift(suite._beforeAll.pop());

      if (tHandler.wrapChildren) {
        suite.beforeAll(() => tHandler.transaction(inPath));

        suite.afterAll(() => tHandler.stop(suiteFailed(suite), inPath));
        // make sure the transaction ends before any other afterAll hook
        suite._afterAll.unshift(suite._afterAll.pop());
      }

      suite.afterAll(() => tHandler.stop(suiteFailed(suite), path));
    }
  });
};

const patchRunner = () => {
  const runnerFn = Mocha.Runner.prototype.run;
  Object.assign(Mocha.Runner.prototype, {
    run: function run(...args) {
      const namespace = tHandler.getNamespace();
      if (tHandler.wrapRoot) {
        // add mocha hooks for starting/rolling back transactions on the boundaries of each test/suite
        makeTransactional(this.suite);
      }
      // bind the Mocha runner in the current CLS namespace of sequelize in order for transactions
      // to be automatically applied to each sequelize operation
      return namespace.bind(runnerFn.bind(this))(...args);
    },
  });
};

const patchMocha = (...args) => {
  tHandler = new TransactionHandler(...args);
  patchRunner();
  return tHandler;
};

module.exports = {
  makeTransactional,
  patchMocha,
};
