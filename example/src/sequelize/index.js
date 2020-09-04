const cls = require('cls-hooked');
const { Sequelize } = require('sequelize');
const { applyExtraSetup } = require('./extra-setup');
const User = require('./models/user.model');
const Instrument = require('./models/instrument.model');
const Orchestra = require('./models/orchestra.model');

const namespace = cls.createNamespace('my-very-own-namespace');
Sequelize.useCLS(namespace);

// In a real app, you should keep the database connection URL as an environment variable.
// But for this example, we will just use a local SQLite database.
// const sequelize = new Sequelize(process.env.DB_CONNECTION_URL);
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: 'sqlite-example-database/example-db.sqlite',
  // logQueryParameters: true,
  // benchmark: true,
  logging: false,
});

const modelDefiners = [User, Instrument, Orchestra];

// We define all models according to their files.
modelDefiners.forEach((modelDefiner) => modelDefiner(sequelize));

// We execute any extra setup after the models are defined, such as adding associations.
applyExtraSetup(sequelize);

// We export the sequelize connection instance to be used around our app.
module.exports = sequelize;
