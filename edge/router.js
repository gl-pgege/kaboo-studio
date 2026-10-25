import cf from 'cloudfront';

const kvs = cf.kvs();

async function handler(event) {
  const request = event.request;
  const uri = request.uri;
  const host = request.headers.host ? request.headers.host.value.split(':')[0] : '';
  const label = host.split('.')[0];
  const file = uri.substring(uri.lastIndexOf('/') + 1).indexOf('.') !== -1;
  if (label === 'preview') {
    if (uri.indexOf('/_preview/') === 0) return request;
    const referer = request.headers.referer ? request.headers.referer.value : '';
    const preview = referer.match(/^https?:\/\/[^/]+\/d\/[^/]+\/([^/]+)\//);
    request.uri = preview && file && uri.indexOf('/d/') !== 0 ? '/_studio/preview/' + preview[1] + '/files/public' + uri : '/_preview/index.html';
    return request;
  }
  if (uri === '/d' || uri.indexOf('/d/') === 0 || uri.indexOf('/_preview/') === 0) {
    return { statusCode: 404, statusDescription: 'Not Found' };
  }
  let live = null;
  try {
    live = await kvs.get('live:' + label);
  } catch (error) {
    live = null;
  }
  if (!live) {
    if (!file) request.uri = '/index.html';
    return request;
  }
  request.uri = '/d/' + live + (file ? uri : uri.replace(/\/?$/, '/') + 'index.html');
  return request;
}
