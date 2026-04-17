export default function InsightChips({ data, labor }) {
  const totalAppts  = data?.appts  ?? 0
  const totalInb    = data?.inb    ?? 0
  const totalOut    = data?.out    ?? 0
  const util        = data?.util   ?? 0
  const laborCount  = labor        ?? 0

  const chips = []

  if (util >= 90)       chips.push({ type: 'alert', text: `Labor at ${util}% capacity` })
  else if (util >= 75)  chips.push({ type: 'warn',  text: `Labor at ${util}% capacity` })
  else                  chips.push({ type: 'ok',    text: `Labor ${util}% utilized` })

  if (totalAppts > 0)   chips.push({ type: 'info',  text: `${totalAppts} appts today` })
  if (totalInb > 0)     chips.push({ type: 'info',  text: `${totalInb} inbound units` })
  if (totalOut > 0)     chips.push({ type: 'info',  text: `${totalOut} outbound units` })
  if (laborCount === 0) chips.push({ type: 'warn',  text: 'No roster assigned' })

  return (
    <div className="insight-chips">
      {chips.map((c, i) => (
        <div key={i} className={`chip ${c.type}`}>
          <span className="chip-dot" />
          {c.text}
        </div>
      ))}
    </div>
  )
}
