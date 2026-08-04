import * as s from './5155.js';
import * as r from './2115.js';
function i() {
  let [e, t] = (0, r.useState)('');
  ((0, r.useEffect)(() => {
    let e = new URLSearchParams(window.location.search).get('q') || '',
      t = document.getElementById('innerHTML-output');
    t && (t.innerHTML = e);
    let n = new URLSearchParams(window.location.search).get('src') || '',
      s = document.getElementById('img-output');
    s && s.setAttribute('src', n);
  }, []),
    (0, r.useEffect)(() => {
      fetch('/api/data')
        .then((e) => e.json())
        .then((e) => t(e.content || ''));
    }, []));
  let n = new URLSearchParams(window.location.search).get('config') || '{}',
    i = {};
  try {
    i = JSON.parse(n);
  } catch (e) {}
  return (
    <div>
      <h1>DOM XSS Lab</h1>
      <section>
        <h2>innerHTML sink (URL param)</h2>
        <div id="innerHTML-output" />
      </section>
      <section>
        <h2>setAttribute src (URL param)</h2>
        <img id="img-output" src="" alt="user-supplied src" />
      </section>
      <section>
        <h2>dangerouslySetInnerHTML (fetch response)</h2>
        <div
          dangerouslySetInnerHTML={{
            __html: e
          }}
        />
      </section>
      <section>
        <h2>dangerouslySetInnerHTML (JSON from URL param)</h2>
        <div
          dangerouslySetInnerHTML={{
            __html: i.html || ''
          }}
        />
      </section>
    </div>
  );
}
export default i;
