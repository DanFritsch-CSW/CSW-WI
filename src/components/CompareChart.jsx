import { Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, Tooltip, Legend,
} from 'chart.js'
import { FACILITY_LIST } from '../lib/constants.js'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend)

export default function CompareChart({ networkData }) {
  if (!networkData) return null

  const labels = FACILITY_LIST.map(f => f.code)
  const colors = FACILITY_LIST.map(f => f.color)

  const data = {
    labels,
    datasets: [
      {
        label: 'Inbound',
        data: FACILITY_LIST.map(f => networkData[f.id]?.inb ?? 0),
        backgroundColor: colors.map(c => `${c}88`),
        borderColor: colors,
        borderWidth: 1,
        borderRadius: 3,
      },
      {
        label: 'Outbound',
        data: FACILITY_LIST.map(f => networkData[f.id]?.out ?? 0),
        backgroundColor: colors.map(c => `${c}44`),
        borderColor: colors.map(c => `${c}99`),
        borderWidth: 1,
        borderRadius: 3,
      },
    ],
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: '#8a9899', font: { family: 'DM Mono', size: 11 } },
      },
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
        ticks: { color: '#4a5859', font: { family: 'DM Mono', size: 11 } },
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
        <span className="chart-title">Network Throughput — Inbound vs Outbound</span>
      </div>
      <div style={{ height: 220 }}>
        <Bar data={data} options={options} />
      </div>
    </div>
  )
}
