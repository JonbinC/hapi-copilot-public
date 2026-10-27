import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRedactor,validate,S,hash,absolutePath,id,readSecret} from '../server/security.mjs';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('redaction preserves numeric usage while suppressing credentials',()=>{
 const redact=makeRedactor(['configured-secret-value']);
 const jwt='eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE5MDAwMDAwMDB9.1234567890signature';
 const x=redact({input_tokens:1500,output_tokens:20,token:jwt,text:'configured-secret-value '+jwt+' api_key=abcdefgh12345678'});
 assert.equal(x.input_tokens,1500);assert.equal(x.token,'[REDACTED]');assert.ok(!JSON.stringify(x).includes(jwt));assert.ok(!JSON.stringify(x).includes('abcdefgh12345678'));
});
test('recursive schema and request path validation reject unsafe values',()=>{
 assert.throws(()=>validate({x:'no'},S.obj({x:S.int(1,2)},['x'])));
 assert.throws(()=>validate({x:[{bad:1}]},S.obj({x:S.arr(S.obj({a:S.str()},['a']))},['x'])));
 assert.throws(()=>validate({x:true,extra:1},S.obj({x:S.bool},['x'])));
 assert.throws(()=>absolutePath('relative'));assert.throws(()=>absolutePath('/ok\0bad'));assert.throws(()=>id('../api'));
 assert.equal(absolutePath('/home/name with spaces'),'/home/name with spaces');
});
test('binary hashes describe the actual bytes',()=>{const b=Buffer.from([1,2,3]);assert.equal(hash(b),createHash('sha256').update(b).digest('hex'));});

test('systemd credential support does not permit ordinary group-readable files or symlinks',t=>{
 const dir=mkdtempSync(join(tmpdir(),'hapi-credential-permissions-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'hapi-access-token');
 writeFileSync(file,'test-only-local-credential',{mode:0o600});
 assert.equal(readSecret(file),'test-only-local-credential');
 chmodSync(file,0o640);
 assert.throws(()=>readSecret(file),{code:'INSECURE_CREDENTIAL_FILE'});
 chmodSync(file,0o440);
 assert.throws(()=>readSecret(file,{credentialsDirectory:dir}),{code:'INSECURE_CREDENTIAL_FILE'});
 assert.throws(()=>readSecret(file,{credentialsDirectory:'/run/credentials/unrelated.service'}),{code:'INSECURE_CREDENTIAL_FILE'});
 chmodSync(file,0o600);
 const link=join(dir,'linked-token');symlinkSync(file,link);
 assert.throws(()=>readSecret(link),{code:'INVALID_CREDENTIAL_FILE'});
});

