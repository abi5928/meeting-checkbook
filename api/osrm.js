export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const { service, points } = req.body || {};
    if (!['trip','route','table'].includes(service) || !Array.isArray(points) || points.length < 2 || points.length > 12) {
      return res.status(400).json({ error: '잘못된 경로 요청입니다.' });
    }

    const coordinates = points.map(p => {
      const lon = Number(p.lon), lat = Number(p.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        throw new Error('좌표가 올바르지 않습니다.');
      }
      return [lon, lat];
    });

    // OSRM의 GET URL에 좌표와 쿼리스트링을 이어 붙이는 방식은
    // 일부 환경에서 InvalidUrl / InvalidQuery(400)를 발생시킬 수 있습니다.
    // route/table은 공식 POST API를 사용해 좌표와 옵션을 JSON body로 전달합니다.
    async function callOsrmPost(kind, body) {
      const url = `https://router.project-osrm.org/${kind}/v1/driving`;
      const upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'meeting-checkbook/25.0'
        },
        body: JSON.stringify(body)
      });
      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); }
      catch { data = { code: 'UpstreamError', message: text.slice(0, 500) }; }
      return { upstream, data };
    }

    if (service === 'table') {
      // 1차: 공식 POST Table API
      const primary = await callOsrmPost('table', {
        coordinates,
        annotations: 'duration,distance'
      });
      if (primary.upstream.ok && primary.data.code === 'Ok' &&
          Array.isArray(primary.data.distances) && Array.isArray(primary.data.durations)) {
        return res.status(200).json(primary.data);
      }

      // 2차: Table이 실패하면 각 쌍을 POST Route로 계산하여 거리표를 재구성
      const n = points.length;
      const distances = Array.from({length:n}, (_,i)=>Array.from({length:n}, (_,j)=>i===j?0:null));
      const durations = Array.from({length:n}, (_,i)=>Array.from({length:n}, (_,j)=>i===j?0:null));
      const failures = [];

      for (let i=0; i<n; i++) {
        for (let j=0; j<n; j++) {
          if (i===j) continue;
          const r = await callOsrmPost('route', {
            coordinates: [coordinates[i], coordinates[j]],
            overview: false,
            steps: false
          });
          const route = r.data?.routes?.[0];
          if (r.upstream.ok && r.data?.code === 'Ok' && route) {
            distances[i][j] = Number(route.distance);
            durations[i][j] = Number(route.duration);
          } else {
            failures.push({
              from: i,
              to: j,
              code: r.data?.code || ('HTTP ' + r.upstream.status),
              message: r.data?.message || '경로 없음'
            });
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
      return res.status(200).json({ code:'Ok', distances, durations, fallbackTried:true });
    }

    if (service === 'route') {
      const result = await callOsrmPost('route', {
        coordinates,
        overview: 'full',
        geometries: 'geojson',
        steps: false
      });
      return res.status(result.upstream.ok ? 200 : result.upstream.status).json(result.data);
    }

    // 현재 앱에서는 trip을 사용하지 않지만, 요청이 들어오면 POST 대신
    // 지원되는 GET 조합으로 처리합니다.
    const qs = new URLSearchParams({
      roundtrip: 'false',
      source: 'first',
      destination: 'last',
      overview: 'full',
      geometries: 'geojson',
      steps: 'false'
    });
    const coordinateString = coordinates.map(([lon,lat]) => `${lon},${lat}`).join(';');
    const url = `https://router.project-osrm.org/trip/v1/driving/${coordinateString}?${qs.toString()}`;
    const upstream = await fetch(url, { headers:{'Accept':'application/json','User-Agent':'meeting-checkbook/25.0'} });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {code:'UpstreamError',message:text.slice(0,500)}; }
    return res.status(upstream.ok ? 200 : upstream.status).json(data);
  } catch (e) {
    return res.status(500).json({ code:'ProxyError', message:e?.message||String(e) });
  }
}
