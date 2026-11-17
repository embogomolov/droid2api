import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';

// Exercise both real normalizers and persistence guards without loading the live singleton.
const api=fs.readFileSync(new URL('../api/keyword-filter-routes.js',import.meta.url),'utf8');
const runtime=fs.readFileSync(new URL('../utils/keyword-filter.js',import.meta.url),'utf8');
const fixture={enabled:false,rules:[{id:'test',name:'Test',enabled:true,
  pattern:{type:'contains',value:'sample',caseSensitive:false},
  action:{type:'delete_keyword',mode:'segment',delimiter:'\n\n',minLength:5,preserveKeywords:['keep']},
  errors:[],alerts:[]}],logging:{enabled:true,logMatches:true,logActions:true}};

for(const kind of ['api','runtime']) {
  let stored=JSON.stringify(fixture), writes=0, warnings=0;
  const context=vm.createContext({isDeepStrictEqual,KEYWORD_CONFIG_PATH:'isolated.json',
    fs:{existsSync:()=>true,readFileSync:()=>stored,writeFileSync:(_path,payload)=>{stored=payload;writes++;}},
    logWarn:()=>warnings++,keywordFilter:{reloadConfig:()=>{}}});
  const source=kind==='api'
    ? api.slice(api.indexOf('const VALID_PATTERN_TYPES'),api.indexOf('// Get keyword filter configuration'))
    : runtime.slice(runtime.indexOf('const PATTERN_TYPE_MAP'),runtime.indexOf('// Singleton instance'));
  vm.runInContext(source,context);
  const run=()=>vm.runInContext(kind==='api' ? 'readKeywordConfig();' : `{
    const filter=Object.create(KeywordFilter.prototype);
    const original=JSON.parse(fs.readFileSync(KEYWORD_CONFIG_PATH));
    filter.persistNormalizedConfig(original,filter.normalizeConfig(original));
  }`,context);
  const reversed=structuredClone(fixture);
  reversed.rules[0].action=Object.fromEntries(Object.entries(reversed.rules[0].action).reverse());
  stored=JSON.stringify(reversed);
  run();run();
  assert.equal(writes,0,kind+': field order must not rewrite config');
  assert.equal(warnings,0,kind+': field order must not warn');
  stored=JSON.stringify({...fixture,enabled:'invalid'});
  run();
  assert.equal(writes,1,kind+': invalid values must still be corrected');
  assert.equal(warnings,1);
  assert.equal(JSON.parse(stored).enabled,false);
  run();assert.equal(writes,1,kind+': normalized config must remain stable');
}
console.log('Keyword config normalization checks passed');
