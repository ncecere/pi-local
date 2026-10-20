import json,sys
d=json.load(open('results.json'))
for mode,v in d.items():
    print("=====",mode, v['frontend']['env']['href'])
    for k,t in v['frontend']['tests'].items():
        if isinstance(t,dict):
            t=json.loads(json.dumps(t))
            for x in ('sample','firstChunks','lastChunks'): t.pop(x,None)
            if 'server' in t: t['server']={k2:t['server'].get(k2) for k2 in ('ctxCancelled','cancelledAfterMs','eventsSent')}
            for sub in ('eventSourceCors','fetchStreamCors'):
                if sub in t and isinstance(t[sub],dict):
                    for x in ('sample','firstChunks','lastChunks','errors'): t[sub].pop(x,None)
        print(" ",k, json.dumps(t))
    print('  hide', v.get('hideOnClose'))
