export default async () => {
  return new Response(JSON.stringify({ status: "ok", test: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};

