import { Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, Tooltip, Legend,
} from 'chart.js'
import { FACILITY_LIST } from '../lib/constants.js'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend)

export default function CompareChart({ networkData, facilityEstDrops = {} }) {
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
        borderColor: colors.map(c => `${c}77`),
        borderWidth: 1,
        borderRadius: 3,
      },
      {
        label: 'Est Drops',
        data: FACILITY_LIST.map(f => facilityEstDrops[f.id] ?? 0),
        backgroundColor: colors.map(c => `${c}bb`),
        borderColor: colors.map(c => `${c}dd`),
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
        labels: { color: '#6b7a90', font: { family: 'DM Mono', size: 11 } },
      },
      tooltip: {
        backgroundColor: '#ffffff',
        borderColor: '#dce2ec',
        borderWidth: 1,
        titleColor: '#6b7a90',
        bodyColor: '#111827',
        titleFont: { family: 'DM Mono', size: 10 },
        bodyFont: { family: 'DM Mono', size: 11 },
      },
    },
    scales: {
      x: {
        grid: { color: '#e8edf3' },
        ticks: { color: '#6b7a90', font: { family: 'DM Mono', size: 11 } },
      },
      y: {
        grid: { color: '#e8edf3' },
        ticks: { color: '#6b7a90', font: { family: 'DM Mono', size: 10 } },
      },
    },
  }

  return (
    <div className="chart-card">
      <div className="chart-header">
        <span className="chart-title">Network Throughput — Inbound / Outbound / Est Drops</span>
      </div>
      <div style={{ height: 220 }}>
        <Bar data={data} options={options} />
      </div>
    </div>
  )
}
