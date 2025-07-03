const stations = [
    {
      id: 'station1',
      name: 'Station 1',
      state: 'California',
      latitude: 34.0522,
      longitude: -118.2437,
    },
    {
      id: 'station2',
      name: 'Station 2',
      state: 'New York',
      latitude: 40.7128,
      longitude: -74.0060,
    },
    {
      id: 'station3',
      name: 'Station 3',
      state: 'California',
      latitude: 37.7749,
      longitude: -122.4194,
    },
  ];

const summary = {
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
  };

const summaryByModel = {
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
};

const states = [...new Set(stations.map(s => s.state))];

module.exports = {
  stations,
  summary,
  summaryByModel,
  states,
};