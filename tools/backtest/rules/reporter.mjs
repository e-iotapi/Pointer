// node --test reporter: one JSON line per leaf test to $BT_OUT ({file,name,ok,err}).
import { appendFileSync } from 'node:fs';
export default async function* reporter(source) {
  for await (const e of source) {
    if (e.type !== 'test:pass' && e.type !== 'test:fail') continue;
    if (e.data.details?.type === 'suite') continue;
    const err = e.data.details?.error;
    appendFileSync(process.env.BT_OUT, JSON.stringify({
      file: (e.data.file ?? '').split('/').pop(), name: e.data.name, ok: e.type === 'test:pass',
      err: err ? String(err.cause?.message ?? err.message ?? err).split('\n')[0].slice(0, 300) : undefined,
    }) + '\n');
  }
}
