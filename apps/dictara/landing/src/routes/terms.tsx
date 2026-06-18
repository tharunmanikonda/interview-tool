import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/terms")({
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="relative py-6 border-b border-white/5">
        <div className="max-w-4xl mx-auto px-6">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-white/60 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-xl font-bold text-gradient-cool">
              Dictara
            </span>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold text-white mb-2">Terms of Service</h1>
        <p className="text-white/40 mb-12">Last updated: December 2025</p>

        <div className="space-y-10 text-white/70 leading-relaxed">
          <p>
            By using Dictara, you agree to these terms. They're simple and
            straightforward.
          </p>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">
              1. What Dictara Is
            </h2>
            <p>
              Dictara is a free, open-source desktop application that transcribes
              your speech to text using AI services (OpenAI or Azure OpenAI).
              You bring your own API keys and pay those providers directly for
              usage.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">
              2. Your Responsibilities
            </h2>
            <ul className="list-disc list-inside space-y-2 ml-4">
              <li>Provide your own valid API keys from OpenAI or Azure</li>
              <li>
                Pay for your own API usage directly to those providers
              </li>
              <li>
                Use the app in compliance with applicable laws and the terms of
                your chosen AI provider
              </li>
              <li>Keep your API keys secure</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">
              3. No Warranty
            </h2>
            <p>
              Dictara is provided{" "}
              <strong className="text-white/90">"as is"</strong> without any
              warranties. We don't guarantee that the app will be error-free,
              uninterrupted, or meet your specific needs. Transcription accuracy
              depends on the AI provider you use.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">
              4. Limitation of Liability
            </h2>
            <p>
              To the maximum extent permitted by law, Dictara and its
              contributors are not liable for any damages arising from your use
              of the app. This includes, but is not limited to, loss of data,
              API costs, or any indirect damages.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">
              5. Third-Party Services
            </h2>
            <p>
              When you use Dictara with OpenAI or Azure, you're also bound by
              their terms of service. We're not responsible for their services,
              pricing, or policies.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">
              6. Open Source
            </h2>
            <p>
              Dictara is open source under the MIT License. You can view,
              modify, and distribute the code according to the license terms.
              See our{" "}
              <a
                href="https://github.com/vitalii-zinchenko/dictara"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cool-cyan hover:underline"
              >
                GitHub repository
              </a>{" "}
              for details.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">
              7. Changes to Terms
            </h2>
            <p>
              We may update these terms from time to time. Continued use of
              Dictara after changes constitutes acceptance of the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-4">
              8. Contact
            </h2>
            <p>
              Questions? Open an issue on our{" "}
              <a
                href="https://github.com/vitalii-zinchenko/dictara/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cool-cyan hover:underline"
              >
                GitHub repository
              </a>
              .
            </p>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-8 border-t border-white/5">
        <div className="max-w-4xl mx-auto px-6 text-center text-white/40 text-sm">
          © {new Date().getFullYear()} Dictara. Open source under MIT.
        </div>
      </footer>
    </div>
  );
}
