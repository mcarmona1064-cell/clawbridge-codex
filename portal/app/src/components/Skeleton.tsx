import clsx from 'clsx';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <div className={clsx('skeleton', className)} />;
}

export function StatsCardsSkeleton() {
  return (
    <div className="space-y-4">
      {/* ROI hero skeleton */}
      <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5 flex items-center gap-5">
        <Skeleton className="w-12 h-12 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-7 w-72" />
        </div>
      </div>
      {/* 8 metric card skeletons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-8 rounded-xl" />
            </div>
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-6">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-20" />
          <Skeleton className="h-10 w-20" />
        </div>
      ))}
    </div>
  );
}

export function IntegrationsSkeleton() {
  return (
    <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5 space-y-3">
      <Skeleton className="h-5 w-40 mb-4" />
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-11 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function BillingSkeleton() {
  return (
    <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5 space-y-3">
      <Skeleton className="h-5 w-36 mb-4" />
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
