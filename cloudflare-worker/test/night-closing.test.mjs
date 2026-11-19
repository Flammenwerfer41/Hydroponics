import test from 'node:test';
import assert from 'node:assert/strict';
import {nightClosingView} from '../../docs/weather/night-closing.mjs';
const reading={measured_at:'2026-11-17T09:15:00Z',astronomy:{night_closing:true,astronomical_dusk:'2026-11-17T09:02:00Z',model:'noaa-fractional-v1-todoroki'},
  values:{battery_voltage:3.8,air_temperature:14.2},quality:{battery_voltage:'valid',air_temperature:'valid'}};
test('night card uses raw voltage conversion, JST time, delay and model versions',()=>{
  const view=nightClosingView(reading,Date.parse('2026-11-17T12:00:00Z'));
  assert.match(view.value,/67%.*3.800V/); assert.match(view.time,/13분 후/);
  assert.match(view.time,/18:15/); assert.match(view.model,/samsung-35e/);
});
test('missing, stale and invalid closing observations are explicit, never replaced with live voltage',()=>{
  assert.match(nightClosingView(null).value,/대기/);
  assert.match(nightClosingView({...reading,values:{battery_voltage:null}},Date.parse('2026-11-17T12:00:00Z')).value,/누락/);
  assert.match(nightClosingView(reading,Date.parse('2026-11-20T12:00:00Z')).note,/오래된/);
  assert.match(nightClosingView({...reading,measured_at:'invalid'}).value,/확인 필요/);
});
