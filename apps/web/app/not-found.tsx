import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-5xl font-semibold text-primary">404</p>
      <p className="text-fg-muted">الصفحة غير موجودة · Page not found</p>
      <Link href="/" className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-fg">
        رجوع · Home
      </Link>
    </div>
  );
}
