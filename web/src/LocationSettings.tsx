import { useEffect, useState } from "react";
import { api } from "./api";

const split = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);
const modes=[['direct-train','Direct train'],['train-transfer','Train + transfer'],['bus','Bus-dominant'],['car-only','Car-only']];

export default function LocationSettings() {
  const [profile, setProfile] = useState<any>();
  const [message, setMessage] = useState("");
  useEffect(() => { api<any>("/api/v1/profile").then(setProfile); }, []);
  if (!profile) return <div className="dense-empty">Loading preferences…</div>;
  const preferences = profile.locationPreferences ?? {}, accessibility=preferences.accessibility??{easyMaxMinutes:45,mediumMaxMinutes:75,closeOverrideKm:40,modePenalties:{'direct-train':0,'train-transfer':10,bus:20},cityProfiles:[]};
  const update = (changes: any) => setProfile({ ...profile, locationPreferences: { ...preferences, ...changes } });
  const updateAccess=(changes:any)=>update({accessibility:{...accessibility,...changes}});
  const updateCity=(index:number,changes:any)=>updateAccess({cityProfiles:accessibility.cityProfiles.map((city:any,i:number)=>i===index?{...city,...changes}:city)});
  const addCity=()=>updateAccess({cityProfiles:[...accessibility.cityProfiles,{city:'',aliases:[],distanceKm:0,publicTransportMinutes:0,mode:'direct-train',source:'Manual estimate',updatedAt:new Date().toISOString().slice(0,10)}]});
  const save = async () => { try{setMessage('');const response = await api<any>("/api/v1/profile", { method: "PUT", body: JSON.stringify(profile) }); setProfile(response.profile); setMessage(`${response.updated} jobs reclassified; recommendation scores kept their existing weighting.`); }catch(error:any){setMessage(error.message??String(error));} };
  return <>
    <header className="page-head dense-head"><div><p>Preferences</p><h1>Location priorities</h1></div><button className="primary" onClick={save}>Save and reclassify</button></header>
    <section className="evidence-section location-settings">
      <div className="section-heading"><div><p>Ranking geography</p><h2>Recommendation weighting</h2></div></div>
      <div className="settings-grid">
        <label>Strongly preferred cities<input value={(preferences.stronglyPreferredCities??[]).join(", ")} onChange={event=>update({stronglyPreferredCities:split(event.target.value)})}/><small>10 of 10 location points</small></label>
        <label>Nearby cities<input value={(preferences.nearbyCities??[]).join(", ")} onChange={event=>update({nearbyCities:split(event.target.value)})}/><small>9 of 10 location points</small></label>
        <label>Scoring distance band<input type="number" min={1} max={200} value={preferences.distanceBandKm??60} onChange={event=>update({distanceBandKm:Number(event.target.value)})}/><small>Existing ranking rule; independent from the commute filter.</small></label>
      </div>
      <div className="location-policy"><strong>Recommendation scoring stays independent</strong><span>The commute categories below control filtering and labels only. They do not add or remove recommendation points.</span></div>
    </section>
    <section className="evidence-section location-settings">
      <div className="section-heading"><div><p>Commute filter</p><h2>Accessibility from Den Bosch</h2></div></div>
      <div className="access-thresholds">
        <label>Easy up to<input type="number" min={0} value={accessibility.easyMaxMinutes} onChange={e=>updateAccess({easyMaxMinutes:Number(e.target.value)})}/><small>effective minutes</small></label>
        <label>Medium up to<input type="number" min={1} value={accessibility.mediumMaxMinutes} onChange={e=>updateAccess({mediumMaxMinutes:Number(e.target.value)})}/><small>effective minutes</small></label>
        <label>Local override<input type="number" min={0} value={accessibility.closeOverrideKm} onChange={e=>updateAccess({closeOverrideKm:Number(e.target.value)})}/><small>kilometres</small></label>
        <label>Transfer penalty<input type="number" min={0} value={accessibility.modePenalties['train-transfer']} onChange={e=>updateAccess({modePenalties:{...accessibility.modePenalties,'train-transfer':Number(e.target.value)}})}/><small>minutes</small></label>
        <label>Bus penalty<input type="number" min={0} value={accessibility.modePenalties.bus} onChange={e=>updateAccess({modePenalties:{...accessibility.modePenalties,bus:Number(e.target.value)}})}/><small>minutes</small></label>
      </div>
      <div className="city-profile-head"><div><strong>City profiles</strong><small>Typical station-to-station estimates; nearby places receive the local override.</small></div><button onClick={addCity}>Add city</button></div>
      <div className="city-profile-wrap"><table className="city-profile-table"><thead><tr><th>City and aliases</th><th>Distance</th><th>Transit</th><th>Mode</th><th>Evidence</th><th/></tr></thead><tbody>
        {accessibility.cityProfiles.map((city:any,index:number)=><tr key={`${city.city}-${index}`}>
          <td><input aria-label={`City ${index+1}`} value={city.city} onChange={e=>updateCity(index,{city:e.target.value})}/><input aria-label={`${city.city||'City'} aliases`} className="aliases" placeholder="Aliases, comma separated" value={(city.aliases??[]).join(', ')} onChange={e=>updateCity(index,{aliases:split(e.target.value)})}/></td>
          <td><input aria-label={`${city.city} distance`} type="number" min={0} value={city.distanceKm} onChange={e=>updateCity(index,{distanceKm:Number(e.target.value)})}/><small>km</small></td>
          <td><input aria-label={`${city.city} travel minutes`} type="number" min={0} disabled={city.mode==='car-only'} value={city.publicTransportMinutes??''} onChange={e=>updateCity(index,{publicTransportMinutes:e.target.value===''?undefined:Number(e.target.value)})}/><small>minutes</small></td>
          <td><select aria-label={`${city.city} transport mode`} value={city.mode} onChange={e=>updateCity(index,{mode:e.target.value,publicTransportMinutes:e.target.value==='car-only'?undefined:city.publicTransportMinutes??0})}>{modes.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></td>
          <td><input aria-label={`${city.city} source`} value={city.source??''} onChange={e=>updateCity(index,{source:e.target.value})}/><small>{city.updatedAt?`Updated ${city.updatedAt}`:'No update date'}</small></td>
          <td><button className="remove-city" title={`Remove ${city.city||'city'}`} onClick={()=>updateAccess({cityProfiles:accessibility.cityProfiles.filter((_:any,i:number)=>i!==index)})}>×</button></td>
        </tr>)}
      </tbody></table></div>
      {message&&<p className={message.includes('jobs reclassified')?'notice':'error'}>{message}</p>}
    </section>
  </>;
}
