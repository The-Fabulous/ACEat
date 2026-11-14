export function runProgressChartChecks(source) {
  const box = {}; new Function('globalThis', source)(box);
  const layout = box.ACEatProgressModel.points;
  const check = (ok, label) => { if (!ok) throw Error(label); };
  const rows = [{ id: 'b', score: 1370, completed_at: '2026-11-14', is_demo: true }, { id: 'a', score: 1320, completed_at: '2026-11-13', is_demo: true }];
  const result = layout(rows, 1400);
  check(result.points[0].score === 1320 && result.points[1].score === 1370, 'Attempts sort chronologically');
  check(result.points[0].x < result.points[1].x && result.points[0].y > result.points[1].y, 'Higher score moves upwards');
  check(result.targetY < result.points[1].y && result.points.every(row => row.is_demo), 'Target and demonstration markers persist');
  check(layout(rows, 1300).targetY > result.points[0].y, 'Changed target moves below scores');
  check(layout([], 1600).points.length === 0, 'Empty history');
  check(Number.isFinite(layout(rows.slice(0, 1), 400).points[0].x), 'Single attempt has a finite position');
  check(layout([{ ...rows[0], score: 400 }], 1600).points[0].y === 290 && layout(rows, 1600).targetY === 40, 'Fixed SAT scale from 400 to 1600');
  const decline = layout([{ ...rows[1], score: 1500 }, rows[0]], 1400);
  check(decline.points[1].y > decline.points[0].y, 'Declining scores are shown honestly');
  return 'Progress graph: order, growth/decline, targets, empty/single history and fixed SAT scale passed';
}
