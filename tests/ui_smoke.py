from pathlib import Path
import json
import os
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
out=root/'reports'/'ui';out.mkdir(parents=True,exist_ok=True)
mock=r'''window.__calls=[];
window.openai={toolOutput:{mode:'owner',machines:[{id:'machine-demo',name:'Development server',home_dir:'/workspaces'},{id:'machine-mac',name:'Mac workstation',home_dir:'/Users/demo/Projects'}],sessions:[{id:'session-demo',title:'Investigate model residuals',flavor:'agy',model:'Selected model',active:true,workspace:'/workspaces/research'},{id:'session-other',title:'Review a parser change',flavor:'cursor',model:'Another model',active:true,workspace:'/workspaces/parser'}],plans:[{title:'Research verification',acceptance:'pending_user',steps:[{id:'measure',state:'running'},{id:'review',state:'planned'}]}],quota:[]},callTool:async(name,args)=>{window.__calls.push({name,args});let data={};if(name==='open_dashboard')data=window.openai.toolOutput;else if(name==='get_session')data={session:{id:args.session_id,title:'Investigate model residuals',flavor:'agy',model:'Selected model',machine_id:'machine-demo',workspace:'/workspaces/research',permission_mode:'request-review',active:true}};else if(name==='get_machine_agents')data={agents:[{agent:'agy',available:true},{agent:'codex',available:true},{agent:'cursor',available:true}]};else if(name==='get_models')data=args.agent==='agy'?{success:true,availableModels:[{modelId:'agy-choice-a',name:'AGY choice A'},{modelId:'agy-choice-b',name:'AGY choice B'}]}:{success:true,models:[{id:'choice-a',displayName:'Choice A'},{id:'choice-b',displayName:'Choice B'}]};else if(name==='browse_machine_directory')data={success:true,entries:[{name:'research',type:'directory'},{name:'README.md',type:'file'}]};else if(name==='read_session_messages')data={messages:[{seq:1,content_excerpt:'Tool ran: python check_balance.py\nExit code: 0\nReported residual: 1.2e-8'}],page:{hasMore:false}};else if(name==='send_session_message')data={operation:{operation_id:'operation-demo',request_id:args.request_id,state:'succeeded',result:{delivery:'submitted',completion:'unverified'}}};else if(name==='spawn_session')data={operation:{operation_id:'spawn-demo',request_id:args.request_id,state:'succeeded',result:{session_id:'session-new',permission_verified:false,requested_permission_mode:args.permission_mode,observed_permission_mode:'always-proceed',dispatch_blocked:true}}};else if(name==='resume_session')data={operation:{operation_id:'resume-demo',request_id:args.request_id,state:'succeeded',result:{session_id:'session-resumed',permission_verified:true,requested_permission_mode:args.permission_mode,observed_permission_mode:args.permission_mode}}};return {structuredContent:data,content:[{type:'text',text:JSON.stringify(data)}]};}};'''
results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
 for w,h in [(1440,1000),(390,844)]:
  page=browser.new_page(viewport={'width':w,'height':h},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content((root/'ui/console.html').read_text().replace('<head>','<head><script>'+mock+'</script>',1));page.wait_for_selector('.session')
  assert page.locator('#mode').inner_text()=='Owner connection'
  page.locator('.session').first.click();page.locator('#messages').click()
  page.locator('#prompt').fill('Inspect the current model output; report the evidence and do not modify raw data.')
  page.locator('#send').click();page.wait_for_function("window.__calls.some(x=>x.name==='send_session_message')")
  calls=page.evaluate('window.__calls');send=[c for c in calls if c['name']=='send_session_message'][-1]
  assert send['args']['session_id']=='session-demo';assert send['args']['request_id'].startswith('ui-')
  page.locator('#send').click();page.wait_for_timeout(20)
  sends=page.evaluate("window.__calls.filter(x=>x.name==='send_session_message')")
  assert sends[-1]['args']['request_id']==sends[-2]['args']['request_id']
  page.select_option('#machine','machine-demo');page.wait_for_function("document.querySelector('#agent').options.length===4")
  page.select_option('#agent','cursor');page.locator('#models').click();page.wait_for_function("document.querySelector('#model-options').options.length===2")
  assert page.locator('#model-options option').first.inner_text()=='Choice A'
  assert not page.locator('#generic-permission-control').is_hidden()
  assert page.locator('#agy-spawn-permission-control').is_hidden()
  page.locator('details > summary').click()
  assert 'unknown' in page.locator('#quota').inner_text()
  page.select_option('#agent','agy');page.locator('#models').click()
  page.wait_for_function("document.querySelector('#model-options').options[0]?.value==='agy-choice-a'")
  assert page.locator('#model-options option').first.inner_text()=='AGY choice A'
  assert page.locator('#agy-spawn-permission-control').is_visible()
  assert page.locator('#generic-permission-control').is_hidden()
  page.locator('#directory').fill('/workspaces/research')
  page.locator('#spawn').click()
  page.wait_for_function("document.querySelector('#status').textContent.includes('Choose request-review or always-proceed')")
  assert 'Choose request-review or always-proceed' in page.locator('#status').inner_text()
  assert not page.evaluate("window.__calls.some(x=>x.name==='spawn_session')")
  page.select_option('#agy-spawn-permission','request-review')
  page.locator('#spawn').click();page.wait_for_function("window.__calls.some(x=>x.name==='spawn_session')")
  spawn=[c for c in page.evaluate('window.__calls') if c['name']=='spawn_session'][-1]
  assert spawn['args']['permission_mode']=='request-review'
  page.wait_for_function("document.querySelector('#status').textContent.includes('UNVERIFIED')")
  assert 'UNVERIFIED' in page.locator('#status').inner_text()
  assert 'session-new' in page.locator('#status').inner_text()
  page.wait_for_function("!document.querySelector('#agy-resume-permission-control').hidden")
  assert page.locator('#agy-resume-permission-control').is_visible()
  page.locator('#resume').click()
  page.wait_for_function("document.querySelector('#status').textContent.includes('Choose request-review or always-proceed')")
  assert 'Choose request-review or always-proceed' in page.locator('#status').inner_text()
  assert not page.evaluate("window.__calls.some(x=>x.name==='resume_session')")
  page.select_option('#agy-resume-permission','request-review')
  page.locator('#resume').click();page.wait_for_function("window.__calls.some(x=>x.name==='resume_session')")
  resume=[c for c in page.evaluate('window.__calls') if c['name']=='resume_session'][-1]
  assert resume['args']['permission_mode']=='request-review'
  page.wait_for_function("document.querySelector('#status').textContent.includes('permission verified: request-review')")
  assert 'permission verified: request-review' in page.locator('#status').inner_text()
  assert not page.evaluate('document.documentElement.scrollWidth>innerWidth'), 'horizontal overflow'
  assert not errors,errors
  page.screenshot(path=str(out/f'console-{w}.png'),full_page=True)
  results.append({'viewport':[w,h],'mode':'mock-host','errors':errors,'request_id_reused':True,'model_choices_unbiased':True,'horizontal_overflow':False})
  page.close()
 browser.close()
(out/'ui-test.json').write_text(json.dumps(results,indent=2))
print(json.dumps(results,indent=2))
