import { Navbar } from '@/components/Navbar';
import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <>
      <Navbar />
      <div className="min-h-screen flex items-center justify-center pt-16">
        <SignUp
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
