/* eslint-env mocha */
const { expect } = require('chai');
const sequelize = require('../../src/sequelize');

const { User } = sequelize.models;

describe('transactions', () => {
  let initialCount;

  describe('rolls back correctly', () => {
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
  });
});
