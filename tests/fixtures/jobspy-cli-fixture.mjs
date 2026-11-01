import {createHash} from 'node:crypto';
const args=process.argv.slice(2),query=args[0]??'',site=args[args.indexOf('--site')+1],location=args[args.indexOf('--location')+1]??'Netherlands';
if(query==='hang'){setInterval(()=>{},1000);}
else if(query==='fail'){process.stderr.write('fixture board failed\n');process.exitCode=1;}
else if(query==='malformed'){process.stdout.write('{bad json}\n');}
else {
 const rows={
  indeed:{site:'indeed',id:'in-abc123',job_url:'https://nl.indeed.com/viewjob?jk=abc123',job_url_direct:'https://careers.example.nl/jobs/42/apply',title:'Data Analyst',company:'Example Analytics B.V.',location:'Amsterdam, Netherlands',date_posted:'2026-10-29',is_remote:false,description:'<p>Analyseer data met SQL en Python.</p>'},
  glassdoor:{site:'glassdoor',id:'gd-987',job_url:'https://www.glassdoor.nl/job-listing/data-scientist.htm?jl=987',title:'Data Scientist',company:'Canal AI',location:'Utrecht, Netherlands',date_posted:'2026-10-30',is_remote:true,description:'Build machine learning models.'}
 };
 if(rows[site]){
  const row=query==='data'?rows[site]:{...rows[site],id:`${site}-${createHash('sha1').update(query+'|'+location).digest('hex').slice(0,12)}`,job_url:`https://jobs.example.test/${site}/${encodeURIComponent(query)}/${encodeURIComponent(location)}`,title:query.replaceAll('"','').split(' OR ')[0],location:`${location}, Netherlands`};
  process.stdout.write(JSON.stringify(row)+'\n');
 }
}
