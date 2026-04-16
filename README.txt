Bircan Migration Backend

This package includes:
- Stripe checkout session creation
- Stripe webhook verification
- Submission storage
- PDF generation
- Client and admin mailers
- Render deployment file

Core flow:
Frontend form -> create checkout session -> pay with Stripe -> webhook confirms payment -> PDF generated -> client/admin email sent -> success page checks status -> PDF download
