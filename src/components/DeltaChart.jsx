import { Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, Tooltip,
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip)

export default function DeltaChart({ hourlyData }) {
  if (!hourlyData?.length) return null

  const deltas = hourlyData.map(r => (r.avail ?? 0) - (r.req ?? 0))
  const labels  = hourlyData.map(r => `${r.h}:00`)

  const data = {
    labels,
    datasets: [{
      label: 'Labor Delta (avail − req)',
      data: deltas,
      backgroundColor: deltas.map(d => d >= 0 ? '#3dba7e55' : '#e05c5c55'),
      borderColor:     deltas.map(d => d >= 0 ? '#3dba7e'   : '#e05c5c'),
      borderWidth: 1,
      borderRadius: 3,
    }],
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#131a1c',
        borderColor: '#1e2a2c',
        borderWidth: 1,
        titleColor: '#8a9899',
        bodyColor: '#e8eced',
        titleFont: { family: 'DM Mono', size: 10 },
        bodyFont: { family: 'DM Mono', size: 11 },
      },
    },
    scales: {
      x: {
        grid: { color: '#152022' },
        ticks: { color: '#4a5859', font: { family: 'DM Mono', size: 10 } },
      },
      y: {
        grid: { color: '#152022' },
        ticks: { color: '#4a5859', font: { family: 'DM Mono', size: 10 } },
      },
    },
  }

  return (
    <div className="chart-card">
      <div className="chart-header">
        <span className="chart-title">Labor Delta (Avail − Required)</span>
      </div>
      <div style={{ height: 140 }}>
        <Bar data={data} options={options} />
      </div>
    </div>
  )
}
