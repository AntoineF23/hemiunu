/** Today's date as YYYY-MM-DD in the user's LOCAL timezone (Date#toISOString is
 *  UTC, which can land on the wrong calendar day near midnight). */
export function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
