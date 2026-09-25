//! wasm-bindgen wrapper around gribberish for the explorer's "gribberish" zarr codec.
//!
//! `decode` mirrors gribberish's Python codec, which calls
//! `parse_grib_array(data, 0, adjust_longitude_range, north_up)`: decode the GRIB2 message at
//! byte 0, then roll longitudes to -180..180 and/or put the northern-most row first. Both
//! adjustments are no-ops on grids they don't apply to.
use gribberish::message::Message;
use wasm_bindgen::prelude::*;

/// Decode the GRIB2 message at the start of `data` into row-major f64 values (NaN where the
/// bitmap marks a point missing).
#[wasm_bindgen]
pub fn decode(data: &[u8], adjust_longitude_range: bool, north_up: bool) -> Result<Vec<f64>, JsError> {
    let message = Message::from_data(data, 0).ok_or_else(|| JsError::new("Failed to read GRIB message"))?;
    let values = message
        .data()
        .map_err(|e| JsError::new(&format!("Failed to decode GRIB data: {e}")))?;
    if !(adjust_longitude_range || north_up) {
        return Ok(values);
    }
    let projector = message
        .latlng_projector()
        .map_err(|e| JsError::new(&format!("Failed to build projection: {e}")))?;
    Ok(projector.adjust_data(values, adjust_longitude_range, north_up))
}

/// Data representation template number (GRIB2 section 5) of the message at the start of `data`.
#[wasm_bindgen]
pub fn drs_template(data: &[u8]) -> Result<u16, JsError> {
    let message = Message::from_data(data, 0).ok_or_else(|| JsError::new("Failed to read GRIB message"))?;
    message.data_template_number().map_err(|e| JsError::new(&format!("{e}")))
}
