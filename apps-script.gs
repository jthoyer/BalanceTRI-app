// Google Apps Script backend for the Balance Tri Club race calendar.
//
// SETUP (one-time, must be done by the sheet owner — Claude cannot do this part):
//   1. Open the Google Sheet.
//   2. Extensions > Apps Script.
//   3. Delete any placeholder code and paste this whole file in.
//   4. Deploy > New deployment > type "Web app".
//      - Execute as: Me
//      - Who has access: Anyone
//   5. Click Deploy, authorize when prompted, and copy the Web app URL (ends in /exec).
//   6. Paste that URL into API_URL near the top of app.js.
//
// Data model: two sheet tabs, created automatically on first request if missing.
//   Races:   id | name | date | location | url | events   (events is "|"-separated)
//   Entries: raceId | name | event | level

const RACES_SHEET = 'Races';
const ENTRIES_SHEET = 'Entries';

function racesSheet_() {
  return getOrCreateSheet_(RACES_SHEET, ['id', 'name', 'date', 'location', 'url', 'events']);
}

function entriesSheet_() {
  return getOrCreateSheet_(ENTRIES_SHEET, ['raceId', 'name', 'event', 'level']);
}

function getOrCreateSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }
  return sheet;
}

function readTable_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  return values
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = row[i]));
      return obj;
    });
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const entries = readTable_(entriesSheet_());
  const races = readTable_(racesSheet_()).map((r) => ({
    id: String(r.id),
    name: r.name,
    date: r.date instanceof Date ? Utilities.formatDate(r.date, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(r.date),
    location: r.location,
    url: r.url,
    events: String(r.events || '').split('|').map((s) => s.trim()).filter(Boolean),
  }));
  races.forEach((r) => {
    r.entries = entries
      .filter((en) => String(en.raceId) === r.id)
      .map((en) => ({ name: en.name, event: en.event, level: en.level }));
  });
  return jsonOut_({ races });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ error: 'invalid JSON body' });
  }
  if (body.action === 'addRace') return jsonOut_(addRace_(body));
  if (body.action === 'saveEntry') return jsonOut_(saveEntry_(body));
  if (body.action === 'addEvent') return jsonOut_(addEvent_(body));
  if (body.action === 'removeEntry') return jsonOut_(removeEntry_(body));
  if (body.action === 'bulkReplace') return jsonOut_(bulkReplace_(body));
  return jsonOut_({ error: 'unknown action: ' + body.action });
}

// Wipes both sheets (keeping headers) and writes the given races/entries in one shot.
// body.races: [{id,name,date,location,url,events:[...]}], body.entries: [{raceId,name,event,level}]
function bulkReplace_(body) {
  const rs = racesSheet_();
  const es = entriesSheet_();
  if (rs.getLastRow() > 1) rs.getRange(2, 1, rs.getLastRow() - 1, rs.getLastColumn()).clearContent();
  if (es.getLastRow() > 1) es.getRange(2, 1, es.getLastRow() - 1, es.getLastColumn()).clearContent();

  const raceRows = (body.races || []).map((r) => [r.id, r.name, r.date, r.location || '', r.url || '', (r.events || []).join('|')]);
  if (raceRows.length) rs.getRange(2, 1, raceRows.length, 6).setValues(raceRows);

  const entryRows = (body.entries || []).map((e) => [e.raceId, e.name, e.event, e.level]);
  if (entryRows.length) es.getRange(2, 1, entryRows.length, 4).setValues(entryRows);

  return { races: raceRows.length, entries: entryRows.length };
}

function addRace_(body) {
  const sheet = racesSheet_();
  const id = 'r' + new Date().getTime();
  sheet.appendRow([
    id,
    body.name,
    body.date,
    body.location || 'Location TBC',
    body.url || '',
    (body.events || []).join('|'),
  ]);
  return { id: id };
}

function saveEntry_(body) {
  const sheet = entriesSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(body.raceId) && values[i][1] === body.name) {
      sheet.getRange(i + 1, 3, 1, 2).setValues([[body.event, body.level]]);
      return { ok: true };
    }
  }
  sheet.appendRow([body.raceId, body.name, body.event, body.level]);
  return { ok: true };
}

function removeEntry_(body) {
  const sheet = entriesSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(body.raceId) && values[i][1] === body.name) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { error: 'entry not found' };
}

function addEvent_(body) {
  const sheet = racesSheet_();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(body.raceId)) {
      const events = String(values[i][5] || '').split('|').map((s) => s.trim()).filter(Boolean);
      if (events.indexOf(body.event) === -1) events.push(body.event);
      sheet.getRange(i + 1, 6).setValue(events.join('|'));
      return { ok: true };
    }
  }
  return { error: 'race not found' };
}
