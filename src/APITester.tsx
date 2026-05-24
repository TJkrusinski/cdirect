import { useRef, type FormEvent } from "react";

export function APITester() {
  const responseInputRef = useRef<HTMLTextAreaElement>(null);

  const testEndpoint = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    try {
      const form = e.currentTarget;
      const formData = new FormData(form);
      const endpoint = formData.get("endpoint") as string;
      const url = new URL(endpoint, location.href);
      const method = formData.get("method") as string;
      const res = await fetch(url, { method });

      const data = await res.json();
      responseInputRef.current!.value = JSON.stringify(data, null, 2);
    } catch (error) {
      responseInputRef.current!.value = String(error);
    }
  };

  return (
    <div className="mx-auto mt-8 flex w-full max-w-2xl flex-col gap-4 text-left">
      <form
        onSubmit={testEndpoint}
        className="flex w-full items-center gap-2 rounded-sm border border-border bg-card p-3 font-mono transition-colors focus-within:border-ring"
      >
        <select
          name="method"
          className="min-w-[0px] cursor-pointer appearance-none rounded-sm border border-border bg-input px-3 py-1.5 text-sm font-bold text-foreground transition-colors hover:bg-accent"
        >
          <option value="GET" className="py-1">
            GET
          </option>
          <option value="PUT" className="py-1">
            PUT
          </option>
        </select>
        <input
          type="text"
          name="endpoint"
          defaultValue="/api/hello"
          className="w-full flex-1 border-0 bg-transparent px-2 py-1.5 font-mono text-base text-foreground outline-none placeholder:text-muted-foreground focus:text-white"
          placeholder="/api/hello"
        />
        <button
          type="submit"
          className="cursor-pointer whitespace-nowrap rounded-sm border border-transparent bg-primary px-5 py-1.5 font-bold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Send
        </button>
      </form>
      <textarea
        ref={responseInputRef}
        readOnly
        placeholder="Response will appear here..."
        className="min-h-[140px] w-full resize-y rounded-sm border border-border bg-card p-3 font-mono text-foreground placeholder:text-muted-foreground focus:border-ring"
      />
    </div>
  );
}
