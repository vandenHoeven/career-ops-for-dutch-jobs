export const normalize = (value: string): string => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export const phrase = (value: string, term: string): boolean => Boolean(normalize(term)) && ` ${normalize(value)} `.includes(` ${normalize(term)} `);

/** Keep company introductions from supplying role evidence for ambiguous titles. */
export function jobSpecificText(description:string):string {
  const start=description.search(/what you(?:'ll| will) do|your responsibilities|your role|the role|job description|responsibilities|over de functie|wat ga je doen|jouw rol|jouw werkzaamheden|you will|you'll|je gaat|this (?:role|position)/i);
  let text=start>=0?description.slice(start):description;
  if(start<0 && /^(?:about\b|our company\b|we are a\b|we build\b|our platform\b|at [\w .-]+,)/i.test(text.trim()))return '';
  const end=text.search(/about (?:the company|us)|who we are|over ons|what we offer|our benefits|why join us/i);
  if(end>0)text=text.slice(0,end);
  return text;
}
