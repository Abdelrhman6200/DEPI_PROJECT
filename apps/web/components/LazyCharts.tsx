'use client';

import dynamic from 'next/dynamic';
import { SkeletonChart } from './Skeleton';

/*
 * The chart library (recharts) is large. Pages load it only when a chart is about to be drawn, so Today,
 * the Companion and the forms open faster; a grey placeholder of the same height shows meanwhile.
 */

export const GlucoseChart = dynamic(() => import('./GlucoseChart').then((m) => m.GlucoseChart), {
  ssr: false,
  loading: () => <SkeletonChart className="h-[260px]" />,
});

export const AgpChart = dynamic(() => import('./AgpChart').then((m) => m.AgpChart), {
  ssr: false,
  loading: () => <SkeletonChart className="h-[280px]" />,
});

export const DailyTirChart = dynamic(() => import('./MiniCharts').then((m) => m.DailyTirChart), {
  ssr: false,
  loading: () => <SkeletonChart className="h-[200px]" />,
});

export const MiniBarChart = dynamic(() => import('./MiniCharts').then((m) => m.MiniBarChart), {
  ssr: false,
  loading: () => <SkeletonChart className="h-[150px]" />,
});

export const MiniLineChart = dynamic(() => import('./MiniCharts').then((m) => m.MiniLineChart), {
  ssr: false,
  loading: () => <SkeletonChart className="h-[150px]" />,
});
