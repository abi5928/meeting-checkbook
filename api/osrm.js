export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const { service, points } = req.body || {};
    if (!['trip','route','table'].includes(service) || !Array.isArray(points) || points.length < 2 || points.length > 12) {
      return res.status(400).json({ error: '잘못된 경로 요청입니다.' });
    }
    const coords = points.map(p => {
      const lon = Number(p.lon), lat = Number(p.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        throw new Error('좌표가 올바르지 않습니다.');
      }
      return `${lon.toFixed(7)},${lat.toFixed(7)}`;
    }).join(';');

    async function callOsrm(kind, coordinateString, params) {
      const qs = new URLSearchParams(params || {});
      const url = `https://router.project-osrm.org/${kind}/v1/driving/${coordinateString}${qs.toString() ? '?' + qs.toString() : ''}`;
      const upstream = await fetch(url, { headers:{'User-Agent':'meeting-checkbook/24.9'} });
      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); } catch { data = {code:'UpstreamError', message:text.slice(0,500)}; }
      return { upstream, data };
    }

    if (service === 'table') {
      // 정상 경로: OSRM Table. 400/NoTable 등이 발생하는 환경에서는
      // 개별 Route 요청으로 거리표를 재구성해 우회합니다.
      const primary = await callOsrm('table', coords, { annotations:'duration,distance' });
      if (primary.upstream.ok && primary.data.code === 'Ok' && Array.isArray(primary.data.distances) && Array.isArray(primary.data.durations)) {
        return res.status(200).json(primary.data);
      }

      const n = points.length;
      const distances = Array.from({length:n}, (_,i)=>Array.from({length:n}, (_,j)=>i===j?0:null));
      const durations = Array.from({length:n}, (_,i)=>Array.from({length:n}, (_,j)=>i===j?0:null));
      const failures = [];
      for (let i=0;i<n;i++) {
        for (let j=0;j<n;j++) {
          if (i===j) continue;
          const pair = `${coords.split(';')[i]};${coords.split(';')[j]}`;
          const r = await callOsrm('route', pair, {overview:'false', steps:'false'});
          const route = r.data?.routes?.[0];
          if (r.upstream.ok && r.data?.code === 'Ok' && route) {
            distances[i][j] = Number(route.distance);
            durations[i][j] = Number(route.duration);
          } else {
            failures.push({from:i,to:j,code:r.data?.code||'HTTP '+r.upstream.status,message:r.data?.message||'경로 없음'});
          }
        }
      }
      if (failures.length) {
        const f = failures[0];
        return res.status(400).json({
          code: f.code,
          message: `선택한 위치 중 자동차 도로 경로를 찾지 못한 구간이 있습니다. (${f.from+1}→${f.to+1}) ${f.message}`,
          fallbackTried: true
        });
      }
      return res.status(200).json({code:'Ok', distances, durations, fallbackTried:true});
    }

    const params = service === 'trip'
      ? { roundtrip:'false', source:'first', destination:'last', overview:'full', geometries:'geojson', steps:'false' }
      : { overview:'full', geometries:'geojson', steps:'false' };
    const result = await callOsrm(service, coords, params);
    return res.status(result.upstream.ok ? 200 : result.upstream.status).json(result.data);
  } catch (e) {
    return res.status(500).json({code:'ProxyError',message:e?.message||String(e)});
  }
}
