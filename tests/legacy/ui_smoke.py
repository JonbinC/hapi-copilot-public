"""Optional mocked MCP Apps host smoke test; no real HAPI/ChatGPT is contacted.
Run: python tests/ui_smoke.py --output /tmp/hapi-ui-qa
Requires Python Playwright and Chromium. Not a production dependency.
"""
from pathlib import Path
import html
import argparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = r'''<!doctype html><meta name="viewport" content="width=device-width"><style>html,body{margin:0;width:100%;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe src="/app"></iframe><script>
const A='12345678-1234-1234-1234-123456789ab0',B='12345678-1234-1234-1234-123456789ab1';
const sessions=[{id:A,title:'[Model] Baseline validation',flavor:'agy',active:true,project:'Model',path:'/workspace/model',pendingRequestsCount:0},{id:B,title:'[Review] Independent checks',flavor:'codex',active:true,project:'Review',path:'/workspace/reviewer',pendingRequestsCount:1}];
let tasks=[{task_id:'qa-task-one',request_id:'qa-request-one',session_id:A,title:'Validate the baseline',kind:'execution',delivery:'submitted',decision:null,revision:2}];
window.calls=[];
addEventListener('message',e=>{const q=e.data;if(!q||q.id===undefined)return;let r={};
 if(q.method==='tools/call'){
  const {name,arguments:a}=q.params;calls.push({name,args:a});
  if(name==='list_sessions')r={sessions};
  if(name==='get_capabilities')r={writes_enabled:true,authorized_targets:[{session_id:A,machine_id:'qa-worker',workspace:'/workspace/model',roles:['execute']},{session_id:B,machine_id:'qa-reviewer',workspace:'/workspace/reviewer',roles:['review']}]};
  if(name==='list_tasks')r={tasks,has_more:false};
  if(name==='get_session')r={session:{...sessions.find(x=>x.id===a.session_id),todos:[]}};
  if(name==='read_session_messages')r={messages:[{event:'agy_tool_action',toolName:'run_command',output:'Mock: pytest -q; 12 passed; exit=0'}],page:{hasMore:false}};
  if(name==='get_session_changes')r={workingTree:{output:' M tests/test_balance.py'}};
  if(name==='get_task')r={task:tasks.find(x=>x.task_id===a.task_id),observed_delivery:'invoked'};
  if(name==='send_task'||name==='request_review'){let t=tasks.find(x=>x.request_id===a.request_id);if(!t){t={task_id:'qa-task-'+tasks.length,request_id:a.request_id,title:a.title||'Independent review',session_id:a.session_id||a.reviewer_session_id,kind:name==='send_task'?'execution':'review',delivery:'submitted',decision:null,revision:2};tasks.push(t)}r={task:t};}
  if(name==='record_task_decision'){let t=tasks.find(x=>x.task_id===a.task_id);t.decision={verdict:a.verdict};t.revision++;r={task:t};}
  r={structuredContent:r,content:[{type:'text',text:JSON.stringify(r)}]};
 }
 e.source.postMessage({jsonrpc:'2.0',id:q.id,result:r},'*');
});</script>'''


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output', default='/tmp/hapi-ui-qa')
    args=parser.parse_args()
    out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    app=(ROOT/'ui/dashboard.html').read_text()
    # Offline mock: provide secure-host UUID behavior without any network access.
    shim='<script>if(!crypto.randomUUID)crypto.randomUUID=()=>`qa-${Date.now()}-${Math.random().toString(16).slice(2)}`;</script>'
    mock=HOST.replace('<iframe src="/app"></iframe>', '<iframe srcdoc="'+html.escape(shim+app,quote=True)+'"></iframe>')
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
            for width,height in [(375,812),(768,1024),(1440,900)]:
                page=browser.new_page(viewport={'width':width,'height':height})
                errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                page.set_content(mock)
                f=page.frame_locator('iframe')
                f.locator('#load-status').filter(has_text='2 found').wait_for()
                f.locator('#write-state').filter(has_text='enabled').wait_for()
                f.locator('.agent').first.click()
                f.locator('#details').filter(has_text='12 passed').wait_for()
                f.locator('summary').click()
                f.locator('#task-target').select_option('12345678-1234-1234-1234-123456789ab0')
                f.locator('#task-title').fill('Smoke test task')
                f.locator('#task-instructions').fill('Run tests; do not change constants.')
                f.locator('#task-criteria').fill('Report real exit status')
                f.locator('#task-outputs').fill('test-report.md')
                f.locator('#send-button').click()
                assert page.evaluate("calls.filter(x=>x.name==='send_task').length") == 0, 'Missing consent must not dispatch'
                f.locator('#task-confirm').check()
                f.locator('#send-button').click()
                page.wait_for_function("calls.filter(x=>x.name==='send_task').length===1")
                f.locator('#task-list').filter(has_text='Smoke test task').wait_for()
                f.locator('#send-button').click()
                page.wait_for_function("calls.filter(x=>x.name==='send_task').length===2")
                keys=page.evaluate("calls.filter(x=>x.name==='send_task').map(x=>x.args.request_id)")
                assert keys[0]==keys[1], 'Identical form retries must reuse the key'
                f.locator('#review-source').select_option('qa-task-one')
                f.locator('#review-target').select_option('12345678-1234-1234-1234-123456789ab1')
                f.locator('#review-focus').fill('Inspect the evidence independently.')
                f.locator('#review-evidence').fill('commit:qa-fixture')
                f.locator('#review-confirm').check()
                f.locator('#review-button').click()
                page.wait_for_function("calls.some(x=>x.name==='request_review')")
                f.locator('button',has_text='Record decision').first.click()
                f.locator('#decision-rationale').fill('Mock user inspected test fixture')
                f.locator('#decision-evidence').fill('report:qa-fixture')
                f.locator('#decision-confirm').check()
                f.locator('#decision-form button').click()
                page.wait_for_function("calls.some(x=>x.name==='record_task_decision')")
                frame=page.frames[1]
                assert frame.evaluate('document.documentElement.scrollWidth <= innerWidth+1'), f'Overflow at {width}'
                assert not errors, errors
                frame.evaluate('window.scrollTo(0,0)')
                content_height=frame.evaluate('document.documentElement.scrollHeight')
                page.locator('iframe').evaluate('(el,h)=>el.style.height=h+"px"',content_height)
                page.screenshot(path=str(out/f'console-{width}.png'),full_page=True)
                page.close()
            browser.close()
        print('PASS: 3 viewport sizes; session evidence, consent, retry identity, review and decision forms (mock host).')
    finally:
        pass

if __name__=='__main__':
    main()
