export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const { service, points } = req.body || {};
    if (!['trip','route'].includes(service) || !Array.isArray(points) || points.length < 2 || points.length > 12) return res.status(400).json({ error: '잘못된 경로 요청입니다.' });
    const coords = points.map(p => {
      const lon = Number(p.lon), lat = Number(p.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error('좌표가 올바르지 않습니다.');
      return `${lon.toFixed(7)},${lat.toFixed(7)}`;
    }).join(';');
    const qs = new URLSearchParams(service === 'trip' ? {
      roundtrip:'false', source:'first', destination:'any', overview:'full', geometries:'geojson', steps:'false'
    } : { overview:'full', geometries:'geojson', steps:'false' });
    const upstream = await fetch(`https://router.project-osrm.org/${service}/v1/driving/${coords}?${qs}`, { headers:{'User-Agent':'meeting-checkbook/24.7'} });
    const text = await upstream.text();
    let data; try { data = JSON.parse(text); } catch { data = {code:'UpstreamError', message:text.slice(0,300)}; }
    return res.status(upstream.ok ? 200 : upstream.status).json(data);
  } catch (e) { return res.status(500).json({code:'ProxyError',message:e?.message||String(e)}); }
}
