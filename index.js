const Mocha = require('mocha');
const EventEmitter = require('events');
const cls = require('cls-hooked');
const { Transaction } = require('sequelize');

const noClsError = new Error(`
  Sequelize does not have a CLS, set it by running Sequelize.useCLS(namespace)
  (https://sequelize.org/master/manual/transactions.html#automatically-pass-transactions-to-all-queries)
`);

class TransactionHandler extends EventEmitter {
  constructor({ sequelize, commitOnError = false } = {}) {
    super();
    const seqInstance = typeof sequelize === 'function' ? sequelize() : sequelize;
    if (!seqInstance.constructor._cls) {
      throw noClsError;
    }
    this.sequelize = sequelize;
    this.commitOnError = commitOnError;
  }

  getNamespaceName() {
    const ns = this._getNamespace();
    if (ns) {
      return ns.name;
    }
    return null;
  }

  getSequelize() {
    return typeof this.sequelize === 'function' ? this.sequelize() : this.sequelize;
  }

  getCurrentTransaction() {
    return this._getNamespace().get('transaction');
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
        this._getNamespace().set('transaction', t);
      }
      this.emit('transaction', t, mochaPath);
      return t;
    });
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

  _getNamespace() {
    const sequelize = this.getSequelize();
    if (!sequelize || !sequelize.constructor._cls) {
      throw noClsError;
    }
    const { name } = sequelize.constructor._cls;
    const namespace = cls.getNamespace(name);
    return namespace;
  }

  _commit(mochaPath) {
    const ended = this._getLastSavepoint();
    if (!ended || ended.finished) {
      return Promise.resolve(ended);
    }
    return ended.commit().then(() => {
      if (!ended.parent) {
        this._getNamespace().set('transaction', null);
      }
      this.emit('commit', ended, mochaPath);
      return ended;
    });
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
        this._getNamespace().set('transaction', null);
      }
      this.emit('rollback', ended, mochaPath);
      return ended;
    });
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

const addMochaHooks = (rootSuite, tHandler) => {
  walkSuite(rootSuite, (suite) => {
    if (suite.root) {
      suite.beforeEach(function beforeEach() {
        const inPath = this.currentTest.fullTitle();
        return tHandler.transaction(inPath);
      });
      suite._beforeEach.unshift(suite._beforeEach.pop());
      suite.afterEach(function afterEach() {
        const inPath = this.currentTest.fullTitle();
        tHandler.stop(suiteFailed(suite), inPath);
      });
    } else {
      const path = suite.fullTitle();
      const inPath = `${suite.fullTitle()} beforeAll`;
      suite.beforeAll(() => tHandler.transaction(path));
      suite._beforeAll.unshift(suite._beforeAll.pop());
      suite.beforeAll(() => tHandler.transaction(inPath));

      suite.afterAll(() => tHandler.stop(suiteFailed(suite), inPath));
      suite._afterAll.unshift(suite._afterAll.pop());
      suite.afterAll(() => tHandler.stop(suiteFailed(suite), path));
    }
  });
};

const patchRunner = (tHandler) => {
  const runnerFn = Mocha.Runner.prototype.run;
  const namespaceName = tHandler.getNamespaceName();
  Object.assign(Mocha.Runner.prototype, {
    run: function run(...args) {
      const namespace = cls.getNamespace(namespaceName);
      // add mocha hooks for starting/rolling back transactions on the boundaries of each test
      addMochaHooks(this.suite, tHandler);
      // bind the Mocha runner in the current CLS namespace of sequelize in order for transactions
      // to be automatically applied to each sequelize operation
      return namespace.bind(runnerFn.bind(this))(...args);
    },
  });
};

const patchMocha = ({ sequelize, commitOnError }) => {
  if (!sequelize) {
    throw new Error('undefined parameter \'sequelize\'');
  }
  const seqInstance = typeof sequelize === 'function' ? sequelize() : sequelize;
  if (!seqInstance.constructor._cls) {
    throw noClsError;
  }
  const tHandler = new TransactionHandler({ sequelize, commitOnError });
  patchRunner(tHandler);
  return tHandler;
};

module.exports = {
  patchMocha,
};
