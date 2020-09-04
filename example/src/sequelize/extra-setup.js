function applyExtraSetup(sequelize) {
  const { Instrument, Orchestra } = sequelize.models;

  Orchestra.hasMany(Instrument);
  Instrument.belongsTo(Orchestra);
}

module.exports = { applyExtraSetup };
