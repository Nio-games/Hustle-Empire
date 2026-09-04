let token=localStorage.getItem("he_token"), state=null;
const $=id=>document.getElementById(id);
async function api(path,opts={}){opts.headers={...(opts.headers||{}),"Content-Type":"application/json"};if(token)opts.headers.Authorization="Bearer "+token;const r=await fetch(path,opts),d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||"Request failed");return d}
function showGame(){ $("auth").hidden=true;$("game").hidden=false;refresh() }
async function register(){try{const d=await api("/api/register",{method:"POST",body:JSON.stringify({username:$("u").value,password:$("p").value})});token=d.token;localStorage.setItem("he_token",token);showGame()}catch(e){$("msg").textContent=e.message}}
async function login(){try{const d=await api("/api/login",{method:"POST",body:JSON.stringify({username:$("u").value,password:$("p").value})});token=d.token;localStorage.setItem("he_token",token);showGame()}catch(e){$("msg").textContent=e.message}}
async function refresh(){try{state=await api("/api/state");render()}catch(e){localStorage.removeItem("he_token");token=null;$("auth").hidden=false;$("game").hidden=true;$("msg").textContent=e.message}}
function money(n){return "$"+Number(n).toLocaleString(undefined,{maximumFractionDigits:0})}
function render(){const p=state.player;$("cash").textContent=money(p.cash);$("rate").textContent=money(p.perSec)+"/s";$("rebirths").textContent=p.rebirths;$("businesses").innerHTML=state.businesses.map(x=>{const b=state.catalog.find(y=>y.id===x.business_id);const buy=b.baseCost*Math.pow(1.15,x.level),up=b.baseCost*2*Math.pow(1.7,x.upgrade),emp=b.baseCost*.75;return `<article class="biz"><div><h3>${b.name}</h3><small>Level ${x.level} Â· Employees ${x.employees} Â· Upgrades ${x.upgrade}</small><br><small>Base income ${money(b.income)}/s</small></div><div class="buttons"><button onclick="act('/api/business/buy','${b.id}')">Buy ${money(buy)}</button><button onclick="act('/api/business/upgrade','${b.id}')">Upgrade ${money(up)}</button><button onclick="act('/api/business/employee','${b.id}')">Hire ${money(emp)}</button></div></article>`}).join("")}
async function act(path,id){try{await api(path,{method:"POST",body:JSON.stringify({businessId:id})});await refresh()}catch(e){alert(e.message)}}
async function daily(){try{const d=await api("/api/reward/daily",{method:"POST"});alert("Reward: "+money(d.reward));refresh()}catch(e){alert(e.message)}}
async function rebirth(){if(!confirm("Rebirth resets businesses but increases your prestige. Continue?"))return;try{await api("/api/rebirth",{method:"POST"});refresh()}catch(e){alert(e.message)}}
async function leaderboard(){try{const d=await api("/api/leaderboard");$("board").textContent="LEADERBOARD\\n"+d.map(x=>`${x.rank}. ${x.username} â Rebirths ${x.rebirths} â ${money(x.lifetimeCash)}`).join("\\n")}catch(e){alert(e.message)}}
if(token)showGame();
setInterval(()=>{if(token)refresh()},5000);
