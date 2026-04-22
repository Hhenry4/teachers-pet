self.addEventListener('push', function(event) {
    let data = { title: 'New Update', body: 'Teacher\\'s Pet has an update for you.' };
    
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: 'https://hhenry4.github.io/teachers-pet/favicon.ico',
        badge: 'https://hhenry4.github.io/teachers-pet/favicon.ico',
        vibrate: [100, 50, 100],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: '2'
        }
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('https://hhenry4.github.io/teachers-pet/')
    );
});
