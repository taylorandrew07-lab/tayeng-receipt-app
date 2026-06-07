import { PageHeader } from "@/components/ui";
import { Uploader } from "@/components/upload/uploader";

export default function UploadPage() {
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Upload documents"
        subtitle="Add receipts, invoices, or statement PDFs. The app reads each one and sorts it automatically — anything uncertain goes to Needs Review."
      />
      <Uploader />
    </div>
  );
}
