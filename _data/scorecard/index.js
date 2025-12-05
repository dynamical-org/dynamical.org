const fetch = require("@11ty/eleventy-fetch");

const stateAbbrToName = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
    "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "AS": "American Samoa", "DC": "District of Columbia", "FM": "Federated States of Micronesia",
    "GU": "Guam", "MH": "Marshall Islands", "MP": "Northern Mariana Islands", "PW": "Palau",
    "PR": "Puerto Rico", "VI": "Virgin Islands"
};

async function getStations() {
  const csvText = await fetch("https://sa.dynamical.org/stations.csv", {
    duration: "1d", // Cache for 1 day
    type: "text",
  });

  const stations = [];
  const lines = csvText.split('\n');
  
  // Skip header line and process data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const columns = line.split(',');
      
      if (columns.length >= 11) {
        // CSV structure: station_id,STATION NAME,latitude,longitude,elevation,ST,wmoId,icao,gsnFlag,hcnCrnFlag,CTRY,...
        const stationId = columns[0].trim();
        const name = columns[1].trim();
        const latitude = parseFloat(columns[2]);
        const longitude = parseFloat(columns[3]);
        const elevation = parseFloat(columns[4]);
        const state = columns[5].trim();
        const wmoId = columns[6].trim();
        const icao = columns[7].trim();
        const gsnFlag = columns[8].trim();
        const hcnCrnFlag = columns[9].trim();
        const countryCode = columns[10].trim();
        
        if (countryCode === 'US' && !isNaN(latitude) && !isNaN(longitude) && state) {
          // Extract network and station components from station ID (format: USXXXXXXXX)
          
          const station = {
            id: stationId,
            country_code: countryCode,
            name,
            state_abbr: state,
            state_name: stateAbbrToName[state] || state,
            latitude,
            longitude,
            elev: isNaN(elevation) ? null : elevation,
            gsn_flag: gsnFlag,
            hcn_crn_flag: hcnCrnFlag,
            wmo_id: wmoId,
            icao: icao,
          };
          stations.push(station);
        }
      }
    }
  }
  return stations;
}

module.exports = async function() {
  const stations = await getStations();
  const states = Object.values(stations.reduce((acc, s) => {
    if (s.state_name && !acc[s.state_name]) {
      acc[s.state_name] = { name: s.state_name, abbr: s.state_abbr };
    }
    return acc;
  }, {}));

  return {
    stations,
    states,
  };
};