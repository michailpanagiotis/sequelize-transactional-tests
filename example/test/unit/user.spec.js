/* eslint-env mocha */
const { expect } = require('chai');
const sequelize = require('src/sequelize');
const { patchMocha, makeTransactional } = require('sequelize-transactional-tests');

sequelize.query('PRAGMA read_uncommitted = true;');

patchMocha({
  sequelize: () => sequelize,
  onTransaction: (t, path) => console.log('started transaction', t.name || t.id, path),
  onCommit: (t, path) => console.log('committed transaction', t.name || t.id, path),
  onRollback: (t, path) => console.log('rolled back transaction', t.name || t.id, path),
});

const { User } = sequelize.models;

describe('User model', makeTransactional(() => {
  let initialCount;
  before(async () => {
    initialCount = await User.count();
  });

  it('creates a user', async () => {
    await User.create({
      username: `username_${initialCount + 1}`,
    });
    // User has actually been created as far as the ORM is concerned (though within a transaction)
    const count = await User.count();
    expect(count).to.equal(initialCount + 1);
  });

  after(async () => {
    // Here, any changes have been rolled back, leaving us with a clean state again
    const afterCount = await User.count();
    expect(afterCount).to.equal(initialCount);
  });
}));
