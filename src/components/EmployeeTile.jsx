import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

function initials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

function avatarColor(name) {
  const palette = ['#e07b4d','#4d9de0','#3dba7e','#d4b84a','#c084fc','#e05c5c','#4dc9e0']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff
  return palette[Math.abs(h) % palette.length]
}

export default function EmployeeTile({ employee, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: employee.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const color = avatarColor(employee.name)
  const isTemp = !!employee.is_temp

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`emp-tile${isDragging ? ' dragging' : ''}${isTemp ? ' emp-temp' : ''}`}
      {...attributes}
      {...listeners}
    >
      <div className="emp-avatar" style={{ background: color }}>
        {initials(employee.name)}
      </div>
      <div className="emp-info">
        <div className="emp-name">{employee.name}</div>
        <div className="emp-role">
          {isTemp && <span className="emp-temp-badge">TEMP</span>}
          {employee.role}
        </div>
      </div>
      {onDelete ? (
        <button
          className="emp-delete-btn"
          onClick={e => { e.stopPropagation(); onDelete() }}
          title="Remove temp employee"
          onPointerDown={e => e.stopPropagation()}
        >×</button>
      ) : (
        <svg className="drag-handle" width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <rect x="2" y="2" width="2" height="2" rx="1"/>
          <rect x="6" y="2" width="2" height="2" rx="1"/>
          <rect x="2" y="5" width="2" height="2" rx="1"/>
          <rect x="6" y="5" width="2" height="2" rx="1"/>
          <rect x="2" y="8" width="2" height="2" rx="1"/>
          <rect x="6" y="8" width="2" height="2" rx="1"/>
        </svg>
      )}
    </div>
  )
}
