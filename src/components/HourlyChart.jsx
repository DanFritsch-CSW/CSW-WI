import { Chart } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale,
  BarController, BarElement,
  LineController, LineElement, PointElement,
  Tooltip, Legend, Filler,
} from 'chart.js'

ChartJS.register(
  CategoryScale, LinearScale,
  BarController, BarElement,
  LineController, LineElement, PointElement,
  Tooltip, Legend, Filler
)

export default function HourlyChart({ hourlyData, color }) {
  if (!hourlyData?.length) return null

  const labels = hourlyData.map(r => `${r.h}:00`)

  const data = {
    labels,
    datasets: [
      {
        label: 'Appointments',
        data: hourlyData.map(r => r.appts),
        backgroundColor: `${color}33`,
        borderColor: color,
        borderWidth: 1,
        borderRadius: 3,
        type: 'bar',
      },
      {
        label: 'Required',
        data: hourlyData.map(r => r.req),
        borderColor: '#e05c5c',
        borderWidth: 2,
        pointRadius: 3,
        fill: false,
        type: 'line',
        tension: 0.3,
        yAxisID: 'y1',
      },
      {
        label: 'Available',
        data: hourlyData.map(r => r.avail),
        borderColor: '#3dba7e',
        borderWidth: 2,
        pointRadius: 3,
        fill: false,
        type: 'line',
        tension: 0.3,
        yAxisID: 'y1',
      },
    ],
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
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
        position: 'left',
      },
      y1: {
        grid: { display: false },
        ticks: { color: '#4a5859', font: { family: 'DM Mono', size: 10 } },
        position: 'right',
      },
    },
  }

  return (
    <div className="chart-card">
      <div className="chart-header">
        <span className="chart-title">Hourly Appointments + Labor</span>
        <div className="chart-legend">
          <span className="legend-item">
            <span className="legend-dot" style={{ background: color }} />Appts
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ background: '#e05c5c' }} />Required
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ background: '#3dba7e' }} />Available
          </span>
        </div>
      </div>
      <div style={{ height: 200 }}>
        <Chart type="bar" data={data} options={options} />
      </div>
    </div>
  )
}
