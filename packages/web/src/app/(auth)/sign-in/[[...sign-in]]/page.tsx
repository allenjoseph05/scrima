import { Navbar } from '@/components/Navbar';
import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <>
      <Navbar />
      <div className="min-h-screen flex items-center justify-center pt-16">
        <SignIn
          appearance={{
            elements: {
              rootBox: 'mx-auto',
              card: 'bg-scrima-card border border-scrima-border',
            },
          }}
        />
      </div>
    </>
  );
}
