// פרטי נסיעה לאפליקציה, לפי אותו זיהוי מקומות שמחליט אם הנסיעה מתאימה לנהג.
// parseRideRoute של הרדאר לא מתאים כאן: הוא ממציא מוצא ("שמש ים" = איסוף בירושלים) וקורא שעה כמחיר.
// כשלא בטוח מה המוצא, לא מציגים מסלול ולא שולחים את הנהג בניווט.
import { extractPrice, findPlaces } from "./matcher.js";
import { generateWazeUrl } from "./geo-helper.js";
import { pickupPoint } from "./driver-app-geo.js";

export function describeRoute(text) {
  const places = findPlaces(text);
  const starts = places.filter((p) => p.role === "from");
  const ends = places.filter((p) => p.role === "to");

  let from = null;
  let to = null;
  if (starts.length === 1 && ends.length === 1) {
    [from, to] = [starts[0], ends[0]];
  } else if (places.length === 2 && starts.length < 2 && ends.length < 2) {
    // בלי מ/ל הסדר הוא מוצא ואז יעד: "שמש ים"
    from = starts[0] || places.find((p) => p.role !== "to");
    to = places.find((p) => p !== from);
  } else if (!starts.length && places.length > 2) {
    // "שמש ים, גאולה": כמה מקומות באותו יעד הם עדיין שתי ערים
    const runs = places.filter((p, i) => i === 0 || p.city !== places[i - 1].city);
    if (runs.length === 2 && runs[0].role !== "to") [from, to] = runs;
  } else if (starts.length === 1) {
    from = starts[0];
  } else if (places.length === 1 && !ends.length) {
    from = places[0];
  }

  const sameCity = from && to && from.city === to.city;
  const label = (place) => (sameCity ? place.phrase : place.city);
  const hasRoute = Boolean(from && to && label(from) !== label(to));

  let waze = null;
  if (from) {
    waze = from.kind === "alias" ? generateWazeUrl(from.city, "") : generateWazeUrl(from.phrase, from.city);
  }

  return {
    checked: true,
    from: hasRoute ? label(from) : "",
    to: hasRoute ? label(to) : "",
    price: extractPrice(text),
    pickup: pickupPoint(from),
    waze,
  };
}
