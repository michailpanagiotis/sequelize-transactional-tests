const sequelize = require('../src/sequelize');
const { pickRandom, randomDate } = require('./helpers/random');

async function reset() {
  console.log('Will rewrite the SQLite example database, adding some dummy data.');

  await sequelize.sync({ force: true });

  await sequelize.models.User.bulkCreate([
    { username: 'jack-sparrow' },
    { username: 'white-beard' },
    { username: 'black-beard' },
    { username: 'brown-beard' },
  ]);

  await sequelize.models.Orchestra.bulkCreate([
    { name: 'Jalisco Philharmonic' },
    { name: 'Symphony No. 4' },
    { name: 'Symphony No. 8' },
  ]);

  const orchestras = await sequelize.models.Orchestra.findAll();

  // Let's create random instruments for each orchestra
  await Promise.all(orchestras.map((orchestra) => {
    const params = [];
    for (let i = 0; i < 10; i += 1) {
      params.push({
        type: pickRandom([
          'violin',
          'trombone',
          'flute',
          'harp',
          'trumpet',
          'piano',
          'guitar',
          'pipe organ',
        ]),
        purchaseDate: randomDate(),
        orchestraId: orchestra.id,
      });
    }
    return sequelize.models.Instrument.bulkCreate(params);
  }));

  console.log('Done!');
}

reset();
