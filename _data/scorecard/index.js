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
  if (lines.length < 2) return stations;

  // Parse header to get column indices by name
  const header = lines[0].trim().split(',');
  const col = {};
  header.forEach((name, i) => { col[name.trim()] = i; });

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const columns = line.split(',');
    const stationId = columns[col["station_id"]]?.trim();
    const name = columns[col["name"]]?.trim() || stationId;
    let longitude = parseFloat(columns[col["longitude"]]);
    const latitude = parseFloat(columns[col["latitude"]]);
    const elevation = parseFloat(columns[col["elevation"]]);
    const state = columns[col["state"]]?.trim();
    const country = columns[col["country"]]?.trim();
    const county = columns[col["county"]]?.trim() || null;
    const wfo = columns[col["wfo"]]?.trim() || null;
    const tzname = columns[col["tzname"]]?.trim() || null;

    if (country !== "US" || isNaN(latitude) || isNaN(longitude) || !state) continue;

    // Handle Aleutians / dateline wrap so Alaska stations project correctly.
    if (state === "AK" && longitude > 0) {
      longitude = longitude - 360;
    }

    stations.push({
      id: stationId,
      name,
      state_abbr: state,
      state_name: stateAbbrToName[state] || state,
      latitude,
      longitude,
      elev: isNaN(elevation) ? null : elevation,
      county,
      wfo,
      tzname,
    });
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