import { useEffect, useState } from "react";
import { api } from "./api";

const split = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);

export default function LocationSettings() {
  const [profile, setProfile] = useState<any>();
  const [message, setMessage] = useState("");
  useEffect(() => { api<any>("/api/v1/profile").then(setProfile); }, []);
  if (!profile) return <div className="dense-empty">Loading preferences…</div>;
  const preferences = profile.locationPreferences ?? {};
  const update = (changes: any) => setProfile({ ...profile, locationPreferences: { ...preferences, ...changes } });
  const save = async () => { const response = await api<any>("/api/v1/profile", { method: "PUT", body: JSON.stringify(profile) }); setProfile(response.profile); setMessage(`${response.updated} jobs rescored with the new location preferences.`); };
  return <>
    <header className="page-head dense-head"><div><p>Preferences</p><h1>Location priorities</h1></div><button className="primary" onClick={save}>Save and rescore</button></header>
    <section className="evidence-section location-settings">
      <div className="section-heading"><div><p>Ranking geography</p><h2>Prefer the Den Bosch region without hiding the Netherlands</h2></div></div>
      <div className="settings-grid">
        <label>Strongly preferred cities<input value={(preferences.stronglyPreferredCities??[]).join(", ")} onChange={event=>update({stronglyPreferredCities:split(event.target.value)})}/><small>10 of 10 location points</small></label>
        <label>Nearby cities<input value={(preferences.nearbyCities??[]).join(", ")} onChange={event=>update({nearbyCities:split(event.target.value)})}/><small>9 of 10 location points</small></label>
        <label>Distance band from Den Bosch<input type="number" min={1} max={200} value={preferences.distanceBandKm??60} onChange={event=>update({distanceBandKm:Number(event.target.value)})}/><small>Kilometres, calculated straight-line; jobs in this band receive 7 points.</small></label>
      </div>
      <div className="location-policy"><strong>Netherlands-wide visibility remains enabled</strong><span>Other Dutch vacancies receive 4 points and stay visible. Explicit Netherlands-remote vacancies receive 7 points. Foreign jobs remain excluded.</span></div>
      {message&&<p className="notice">{message}</p>}
    </section>
  </>;
}
