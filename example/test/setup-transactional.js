const { patchMocha } = require('sequelize-transactional-tests');

const sequelize = require('../src/sequelize');

sequelize.query('PRAGMA read_uncommitted = true;');

const transactionScope = patchMocha({
  sequelize: () => sequelize, commitOnError: false, wrapRoot: true,
});

transactionScope.on('transaction', (t, path) => {
  console.log('started transaction', t.name || t.id, path);
});

transactionScope.on('commit', (t, path) => {
  console.log('commited transaction', t.name || t.id, path);
});

transactionScope.on('rollback', (t, path) => {
  console.log('rolled back transaction', t.name || t.id, path);
});
