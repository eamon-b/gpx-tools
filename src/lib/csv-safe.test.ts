import { describe, it, expect } from 'vitest';
import { csvSafeCell, csvSafeRows } from './csv-safe';
import { processGpxTravelPlan } from './gpx-datasheet';

describe('csvSafeCell', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])(
    'prefixes a formula-looking string %j',
    value => {
      expect(csvSafeCell(value)).toBe(`'${value}`);
    }
  );

  it('leaves ordinary strings and numbers alone', () => {
    expect(csvSafeCell('Hut 3 = water')).toBe('Hut 3 = water');
    expect(csvSafeCell('')).toBe('');
    expect(csvSafeCell(-12.5)).toBe(-12.5);
  });

  it('maps every cell of a table', () => {
    expect(csvSafeRows([['=x', 1], ['ok', -1]])).toEqual([["'=x", 1], ['ok', -1]]);
  });
});

describe('datasheet CSV output', () => {
  it('does not emit a waypoint name or note as a live formula', () => {
    const gpx = `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="-37.8" lon="145.0"><name>=HYPERLINK("http://evil.test","x")</name><desc>@SUM(1)</desc></wpt>
  <trk><trkseg>
    <trkpt lat="-37.8" lon="145.0"><ele>10</ele></trkpt>
    <trkpt lat="-37.81" lon="145.0"><ele>20</ele></trkpt>
  </trkseg></trk>
</gpx>`;
    const result = processGpxTravelPlan(gpx);
    expect(result.processedPlan).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
    expect(result.processedPlan).toContain(`"'@SUM(1)"`);
    expect(result.processedPlan).not.toMatch(/(^|[,\n])"=/);
  });
});
