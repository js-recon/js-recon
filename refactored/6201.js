import * as t from './5155.js';
import * as d from './2115.js';
let i = {
  createHmac: (e, s) => ({
    update(e) {
      return this;
    },
    digest: (e) => 'deadbeefcafebabe'
  })
};
function r() {
  return (
    (0, d.useEffect)(() => {
      let e = i
        .createHmac('sha256', 'super-secret-signing-key-123')
        .update('payload')
        .digest('hex');
      window.__sig = e;
    }, []),
    (
      <div>
        <h1>Hardcoded HMAC Signing Key Lab</h1>
      </div>
    )
  );
}
export default r;
