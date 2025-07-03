module.exports = {
  stationId: 'station1',
  metrics: {
    gefs: {
      yesterday: {
        mae: 0.5,
        rmse: 0.7,
        bias: 0.1,
      },
      last3days: {
        mae: 0.6,
        rmse: 0.8,
        bias: 0.2,
      },
      last7days: {
        mae: 0.7,
        rmse: 0.9,
        bias: 0.3,
      },
      last14days: {
        mae: 0.8,
        rmse: 1.0,
        bias: 0.4,
      },
    },
    gfs: {
      yesterday: {
        mae: 0.4,
        rmse: 0.6,
        bias: 0.05,
      },
      last3days: {
        mae: 0.5,
        rmse: 0.7,
        bias: 0.15,
      },
      last7days: {
        mae: 0.6,
        rmse: 0.8,
        bias: 0.25,
      },
      last14days: {
        mae: 0.7,
        rmse: 0.9,
        bias: 0.35,
      },
    },
  },
};