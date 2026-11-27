import { redirect } from 'next/navigation';

/** L'accueil mène aux missions ; la garde de session renvoie à la connexion si besoin. */
export default function HomePage(): never {
  redirect('/missions');
}
